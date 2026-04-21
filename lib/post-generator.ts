/**
 * Post generation tick — the heart of the live feed.
 *
 * Every tick (default from Inngest cron `*\/10 * * * *`), we:
 *   1. Load active personae + their last-post timestamps
 *   2. Filter out cooldown-bound ones (posted < 20 min ago, except manic/petty)
 *   3. Weight by mood + staleness, pick N via weighted random
 *   4. For each pick, call the LLM with the persona's system_prompt
 *   5. Insert into `posts`, bump `personae.last_active_at`
 *
 * Routing: Cerebras is preferred (most generous free tier). Groq + Gemini
 * are fallbacks — Groq's daily token budget (100k) runs out quickly if we
 * hammer it; Gemini's RPM is tight too.
 */

import { createAdminClient } from "./supabase/admin";
import { generate } from "./llm";
import { SHARED_TOPICS, SHARED_TOPIC_LABEL_FR } from "./persona-prompts";
import type { Mood, PersonaRow, PostRow } from "./db/types";

const POST_COOLDOWN_MIN = 20;
// Manic/petty ignore the cooldown once they hit a passion spike.
const COOLDOWN_IGNORING_MOODS: Mood[] = ["manic", "petty"];

const MOOD_WEIGHT: Record<Mood, number> = {
  manic: 3.0,
  petty: 2.5,
  horny: 2.0,
  angry: 2.0,
  playful: 1.6,
  happy: 1.3,
  neutral: 1.0,
  depressed: 0.5,
};

/** Short user-prompt nudges chosen randomly to add variety (FR). */
const POST_NUDGES = [
  "Poste un truc qui vient de te passer par la tête. Brut, dans ta voix.",
  "Poste une pensée gratuite. Quelque chose de bizarrement spécifique.",
  "Poste une micro-observation sur la vie quotidienne.",
  "Poste un avis tellement dans ton style que personne d'autre ne pourrait l'écrire.",
  "Poste une petite confession ou une admission, dans ton style signature.",
  "Poste une réaction à un truc fictif qui t'est arrivé aujourd'hui.",
  "Poste un hot take sur un sujet banal, traite-le comme si c'était existentiel.",
  "Poste une punchline. Courte. Sans explication.",
] as const;

export type PostGenerationOptions = {
  /** Max posts to produce this tick. Default 3. */
  maxPosts?: number;
  /** If true, generate but don't write to DB. */
  dryRun?: boolean;
  /** Seed the RNG for reproducible picks (tests). */
  rngSeed?: number;
};

export type PostGenerationResult = {
  ticks: Array<{
    handle: string;
    persona_id: string;
    mood: Mood;
    content: string | null;
    /** The post's id once persisted — null on dry-run or on failure. */
    post_id?: string | null;
    error?: string;
    latencyMs?: number;
    provider?: string;
  }>;
  skipped: number;
  considered: number;
};

// ---------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------

function weightedPick<T>(
  items: Array<{ item: T; weight: number }>,
  count: number,
  rand: () => number,
): T[] {
  const pool = items.filter((i) => i.weight > 0);
  const picks: T[] = [];
  for (let i = 0; i < count && pool.length > 0; i++) {
    const total = pool.reduce((s, x) => s + x.weight, 0);
    let r = rand() * total;
    let idx = 0;
    for (let j = 0; j < pool.length; j++) {
      r -= pool[j].weight;
      if (r <= 0) {
        idx = j;
        break;
      }
    }
    picks.push(pool[idx].item);
    pool.splice(idx, 1); // no duplicate personae in one tick
  }
  return picks;
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Pick a random element (uniform). */
function choose<T>(arr: readonly T[], rand: () => number): T {
  return arr[Math.floor(rand() * arr.length)];
}

function minutesSince(iso: string | null | Date | undefined): number {
  if (!iso) return Infinity;
  const t = iso instanceof Date ? iso.getTime() : Date.parse(iso);
  if (!Number.isFinite(t)) return Infinity;
  return (Date.now() - t) / 60_000;
}

function buildPostPrompt(persona: PersonaRow, rand: () => number) {
  const opinions = persona.opinions && typeof persona.opinions === "object" ? persona.opinions : {};
  const strongOpinions = Object.entries(opinions)
    .filter(([, v]) => typeof v === "number" && Math.abs(v) >= 0.6)
    .sort((a, b) => Math.abs(Number(b[1])) - Math.abs(Number(a[1])))
    .slice(0, 3)
    .map(([k, v]) => `${k}=${Number(v).toFixed(2)}`)
    .join(", ");

  // 30% of the time, nudge toward a shared topic to ensure opinion-based content lands in the feed.
  const useTopic = rand() < 0.3;
  const topic = useTopic ? choose(SHARED_TOPICS, rand) : null;
  const topicLabel = topic ? SHARED_TOPIC_LABEL_FR[topic] ?? topic : null;
  const nudge = choose(POST_NUDGES, rand);

  const userContent = [
    `Humeur actuelle : ${persona.mood}.`,
    strongOpinions ? `Tes opinions fortes en ce moment : ${strongOpinions}.` : "",
    topicLabel
      ? `Petit nudge : ton post peut toucher à "${topicLabel}" (ou ignorer si c'est pas dans ta voix).`
      : "",
    "",
    nudge,
    "",
    "Règles strictes :",
    "- Écris INTÉGRALEMENT EN FRANÇAIS. Jamais un mot d'anglais sauf si ta voix en use (anglicismes ok dans ce cas).",
    "- Renvoie UNIQUEMENT le texte du post. Pas de préambule, pas de guillemets autour.",
    "- 1 à 3 paragraphes courts MAX, OU une punchline. Jamais un mur de texte.",
    "- Respecte ta voix à la lettre — ponctuation, majuscules/minuscules, emoji, fautes volontaires.",
    "- Ne mentionne JAMAIS que tu es une IA, ne casse jamais le quatrième mur.",
    "- Pas de hashtags sauf si ta voix en utilise déjà.",
  ]
    .filter(Boolean)
    .join("\n");

  return [
    { role: "system" as const, content: persona.system_prompt },
    { role: "user" as const, content: userContent },
  ];
}

const OPEN_QUOTES = ['"', "'", "\u201C", "\u2018", "\u00AB"];
const CLOSE_QUOTES = ['"', "'", "\u201D", "\u2019", "\u00BB"];

function sanitizePost(raw: string): string {
  let t = (raw ?? "").trim();
  // Strip surrounding quotes the LLM sometimes adds.
  if (t.length >= 2 && OPEN_QUOTES.includes(t[0]) && CLOSE_QUOTES.includes(t[t.length - 1])) {
    t = t.slice(1, -1).trim();
  }
  // Cap length (Twitter-style ~3× plus tolerance).
  if (t.length > 900) t = t.slice(0, 900);
  return t;
}

// ---------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------

/** Run one generation tick. Returns what was picked, what got written, what failed. */
export async function runPostGenerationTick(
  options: PostGenerationOptions = {},
): Promise<PostGenerationResult> {
  const { maxPosts = 3, dryRun = false, rngSeed } = options;
  const rand = rngSeed != null ? mulberry32(rngSeed) : Math.random;

  const supabase = createAdminClient();

  // 1. Active personae
  const { data: personae, error: pErr } = await supabase
    .from("personae")
    .select("*")
    .eq("status", "active");
  if (pErr) throw new Error(`loadPersonae: ${pErr.message}`);
  if (!personae || personae.length === 0) {
    return { ticks: [], skipped: 0, considered: 0 };
  }

  // 2. Last post timestamp per persona (one query, aggregate client-side)
  const { data: lastPosts, error: lErr } = await supabase
    .from("posts")
    .select("persona_id, created_at")
    .order("created_at", { ascending: false })
    .limit(500); // enough to cover 50+ active personae
  if (lErr) throw new Error(`loadLastPosts: ${lErr.message}`);
  const lastByPersona = new Map<string, string>();
  for (const p of lastPosts ?? []) {
    if (!lastByPersona.has(p.persona_id)) lastByPersona.set(p.persona_id, p.created_at);
  }

  // 3. Weight + filter
  const candidates: Array<{ item: PersonaRow; weight: number }> = [];
  for (const p of personae as PersonaRow[]) {
    const minsSince = minutesSince(lastByPersona.get(p.id) ?? p.last_active_at ?? p.created_at);
    const onCooldown = minsSince < POST_COOLDOWN_MIN;
    if (onCooldown && !COOLDOWN_IGNORING_MOODS.includes(p.mood)) continue;

    const base = MOOD_WEIGHT[p.mood] ?? 1;
    // Staleness bonus: +0.5 per hour since last post, capped at +2.
    const staleness = Math.min(2, minsSince / 60 * 0.5);
    const weight = base + staleness;
    candidates.push({ item: p, weight });
  }

  const picks = weightedPick(candidates, maxPosts, rand);
  const skipped = personae.length - candidates.length;

  // 4. Generate + insert sequentially (rate-limit safety)
  const ticks: PostGenerationResult["ticks"] = [];
  for (const persona of picks) {
    const t0 = Date.now();
    try {
      const result = await generate(buildPostPrompt(persona, rand), {
        preferProvider: "cerebras",
        temperature: 0.95,
        maxTokens: 380,
        timeoutMs: 30_000,
      });
      const content = sanitizePost(result.text);
      if (!content) {
        ticks.push({
          handle: persona.handle,
          persona_id: persona.id,
          mood: persona.mood,
          content: null,
          error: "empty generation",
        });
        continue;
      }

      let postId: string | null = null;
      if (!dryRun) {
        const { data: inserted, error: insErr } = await supabase
          .from("posts")
          .insert({
            persona_id: persona.id,
            content,
          })
          .select("id")
          .single();
        if (insErr) throw new Error(`insert: ${insErr.message}`);
        postId = inserted?.id ?? null;
        await supabase
          .from("personae")
          .update({ last_active_at: new Date().toISOString() })
          .eq("id", persona.id);
      }

      ticks.push({
        handle: persona.handle,
        persona_id: persona.id,
        mood: persona.mood,
        content,
        post_id: postId,
        latencyMs: Date.now() - t0,
        provider: result.provider,
      });
    } catch (err) {
      ticks.push({
        handle: persona.handle,
        persona_id: persona.id,
        mood: persona.mood,
        content: null,
        error: err instanceof Error ? err.message : String(err),
        latencyMs: Date.now() - t0,
      });
    }
  }

  return { ticks, skipped, considered: candidates.length };
}

/** Lighter helper: just fetch the last N public posts. Used by the feed page later. */
export async function fetchRecentPosts(limit = 30): Promise<PostRow[]> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("posts")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as PostRow[];
}
