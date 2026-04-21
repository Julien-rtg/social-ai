/**
 * Reply generation — the engine behind IA→IA cascade (J13).
 *
 * Given a parent post and a viewer persona, produce a reply that is
 * (a) in the viewer's voice, (b) aware of the relationship between
 * viewer and author, and (c) short + punchy (replies must feel like
 * reactions, not essays).
 *
 * Persistence note: replies are stored as new rows in `posts` with
 * `in_reply_to_post_id` + `reply_to_persona_id` set — Twitter model.
 * Keeping replies in the same table means the feed query "just works"
 * and threaded views come free later.
 */

import { createAdminClient } from "./supabase/admin";
import { generate } from "./llm";
import type { Mood, PersonaRow, RelationshipKind, RelationshipRow } from "./db/types";

/** Anti-flood: how recently a viewer can have posted before we skip them. */
const VIEWER_COOLDOWN_MIN = 5;

/** Weight table for picking which personae see a post. */
const MOOD_VIEW_WEIGHT: Record<Mood, number> = {
  manic: 2.8,
  petty: 2.5,
  horny: 2.0,
  angry: 2.0,
  playful: 1.6,
  happy: 1.2,
  neutral: 0.8,
  depressed: 0.4,
};

/** Relationships with emotional charge reply more. Neutral and friendship reply less. */
const REL_VIEW_WEIGHT: Record<RelationshipKind, number> = {
  crush: 2.8,
  love: 2.5,
  hate: 2.5,
  rivalry: 2.3,
  friendship: 1.4,
  neutral: 1.0,
};

/** Tone instruction injected in the user prompt based on the viewer's edge toward the author (FR). */
const REL_TONE: Record<RelationshipKind, string> = {
  crush: "Tu as un crush sur iel. Reste subtil·e — un peu flirty mais pas désespéré·e.",
  love: "Tu l'aimes. Chaleureux·se, intime, parfois un peu trop.",
  friendship: "C'est un·e de tes gens. Banter, soutien léger, private jokes.",
  rivalry: "Tu le/la vois comme un·e rival·e. Compétitif·ve, piques déguisées, énergie one-up.",
  hate: "Tu le/la détestes pour de vrai. Sec, cassant, effort minimal, tu ne joues jamais sur son terrain.",
  neutral: "Tu n'as pas de sentiment fort. Réagis honnêtement au contenu lui-même.",
};

export type ReplyCandidate = {
  viewer: PersonaRow;
  edge: Pick<RelationshipRow, "kind" | "score" | "notes"> | null;
  weight: number;
};

export type ReplyGenerationOptions = {
  parentPostId: string;
  parentPersonaId: string;
  viewerPersonaId: string;
  dryRun?: boolean;
};

export type ReplyGenerationResult = {
  post_id: string | null;
  content: string | null;
  provider?: string;
  latencyMs?: number;
  skippedReason?: string;
};

// ---------------------------------------------------------------------
// Viewer selection
// ---------------------------------------------------------------------

/**
 * Pick N candidate viewers for a given post, weighted by mood + relationship
 * strength. Excludes the author. Returns candidates ordered by weight desc
 * so the caller can take(top N).
 *
 * Design decision: ALWAYS weight emotional edges highest. A neutral persona
 * reacting to a random post = boring feed. A rival clapping back = drama.
 */
export async function pickReplyCandidates(
  parentPersonaId: string,
  authorMood: Mood,
  count: number,
): Promise<ReplyCandidate[]> {
  const supabase = createAdminClient();

  // Inbound relationships: "people who have feelings ABOUT the author".
  // These are our prime cascade candidates because the edge is TOWARD the post's author.
  const { data: inbound, error: relErr } = await supabase
    .from("relationships")
    .select("from_persona_id, kind, score, notes")
    .eq("to_persona_id", parentPersonaId)
    .limit(60);
  if (relErr) throw new Error(`pickReplyCandidates.rel: ${relErr.message}`);

  const edgeByViewer = new Map<
    string,
    Pick<RelationshipRow, "kind" | "score" | "notes">
  >();
  for (const e of inbound ?? []) {
    edgeByViewer.set(e.from_persona_id, {
      kind: e.kind,
      score: e.score,
      notes: e.notes ?? "",
    });
  }

  // Personae pool (active only, exclude author).
  const { data: personae, error: pErr } = await supabase
    .from("personae")
    .select("*")
    .eq("status", "active")
    .neq("id", parentPersonaId);
  if (pErr) throw new Error(`pickReplyCandidates.personae: ${pErr.message}`);
  if (!personae || personae.length === 0) return [];

  // Viewer cooldown: don't pull in personae who just posted.
  const since = new Date(Date.now() - VIEWER_COOLDOWN_MIN * 60 * 1000).toISOString();
  const { data: recent } = await supabase
    .from("posts")
    .select("persona_id, created_at")
    .gte("created_at", since);
  const recentPosters = new Set((recent ?? []).map((r) => r.persona_id));

  const candidates: ReplyCandidate[] = [];
  for (const viewer of personae as PersonaRow[]) {
    if (recentPosters.has(viewer.id)) continue; // cooled off, skip

    const edge = edgeByViewer.get(viewer.id) ?? null;
    const moodW = MOOD_VIEW_WEIGHT[viewer.mood] ?? 1;
    const relW = edge
      ? REL_VIEW_WEIGHT[edge.kind] * (0.6 + Math.abs(edge.score) * 0.8)
      : 0.35; // strangers barely engage
    // Mild author-mood bonus: manic/petty posts attract more replies.
    const authorW = authorMood === "manic" || authorMood === "petty" ? 1.2 : 1;

    const weight = moodW * relW * authorW;
    if (weight <= 0) continue;
    candidates.push({ viewer, edge, weight });
  }

  candidates.sort((a, b) => b.weight - a.weight);

  // Weighted-random pick among the top 3× desired — keeps variety, avoids
  // the same hate-fuelled rival answering every post.
  const poolSize = Math.min(candidates.length, count * 3);
  const pool = candidates.slice(0, poolSize);
  return weightedSampleWithoutReplacement(pool, count);
}

function weightedSampleWithoutReplacement(
  items: ReplyCandidate[],
  count: number,
): ReplyCandidate[] {
  const pool = [...items];
  const picks: ReplyCandidate[] = [];
  while (picks.length < count && pool.length > 0) {
    const total = pool.reduce((s, x) => s + x.weight, 0);
    let r = Math.random() * total;
    let idx = 0;
    for (let i = 0; i < pool.length; i++) {
      r -= pool[i].weight;
      if (r <= 0) {
        idx = i;
        break;
      }
    }
    picks.push(pool[idx]);
    pool.splice(idx, 1);
  }
  return picks;
}

// ---------------------------------------------------------------------
// Reply generation (single viewer → single post)
// ---------------------------------------------------------------------

/**
 * Generate + persist a reply from `viewer` to `parent`.
 *
 * Anti-loop: we check the viewer's most recent post. If it was already
 * a reply to the same author, we skip — preserves the "no 2-in-a-row"
 * rule from the plan without needing a history table.
 */
export async function generateReplyFor(
  options: ReplyGenerationOptions,
): Promise<ReplyGenerationResult> {
  const { parentPostId, parentPersonaId, viewerPersonaId, dryRun = false } = options;
  const supabase = createAdminClient();

  // Load the parent post + its author + the viewer. One round-trip each.
  const [parentRes, authorRes, viewerRes, edgeRes, lastByViewerRes, alreadyRepliedRes] =
    await Promise.all([
      supabase.from("posts").select("id, content, persona_id").eq("id", parentPostId).maybeSingle(),
      supabase.from("personae").select("*").eq("id", parentPersonaId).maybeSingle(),
      supabase.from("personae").select("*").eq("id", viewerPersonaId).maybeSingle(),
      supabase
        .from("relationships")
        .select("kind, score, notes")
        .eq("from_persona_id", viewerPersonaId)
        .eq("to_persona_id", parentPersonaId)
        .maybeSingle(),
      // Viewer's most recent post — for the 2-in-a-row check.
      supabase
        .from("posts")
        .select("id, reply_to_persona_id, created_at")
        .eq("persona_id", viewerPersonaId)
        .order("created_at", { ascending: false })
        .limit(1),
      // Did the viewer already reply to THIS specific post? Hard skip if so.
      supabase
        .from("posts")
        .select("id")
        .eq("persona_id", viewerPersonaId)
        .eq("in_reply_to_post_id", parentPostId)
        .limit(1),
    ]);

  if (parentRes.error) throw new Error(`reply.parent: ${parentRes.error.message}`);
  if (authorRes.error) throw new Error(`reply.author: ${authorRes.error.message}`);
  if (viewerRes.error) throw new Error(`reply.viewer: ${viewerRes.error.message}`);

  const parent = parentRes.data;
  const author = authorRes.data as PersonaRow | null;
  const viewer = viewerRes.data as PersonaRow | null;
  if (!parent || !author || !viewer) {
    return { post_id: null, content: null, skippedReason: "missing row" };
  }

  // Anti-loop hard skip: already replied to this exact post.
  if ((alreadyRepliedRes.data ?? []).length > 0) {
    return { post_id: null, content: null, skippedReason: "already replied to this post" };
  }

  // Anti-loop soft skip: viewer's last post was already a reply to the same author → bounce.
  const lastByViewer = (lastByViewerRes.data ?? [])[0];
  if (lastByViewer?.reply_to_persona_id === parentPersonaId) {
    return {
      post_id: null,
      content: null,
      skippedReason: "two-in-a-row to same author (anti-loop)",
    };
  }

  const edge = edgeRes.data as
    | Pick<RelationshipRow, "kind" | "score" | "notes">
    | null;

  const prompt = buildReplyPrompt(viewer, author, parent.content, edge);

  const t0 = Date.now();
  const result = await generate(prompt, {
    preferProvider: "cerebras",
    temperature: 0.95,
    maxTokens: 240, // replies MUST be shorter than posts
    timeoutMs: 30_000,
  });
  const content = sanitizeReply(result.text);
  if (!content) {
    return { post_id: null, content: null, skippedReason: "empty generation" };
  }

  if (dryRun) {
    return {
      post_id: null,
      content,
      provider: result.provider,
      latencyMs: Date.now() - t0,
    };
  }

  const { data: inserted, error: insErr } = await supabase
    .from("posts")
    .insert({
      persona_id: viewer.id,
      content,
      in_reply_to_post_id: parent.id,
      reply_to_persona_id: author.id,
    })
    .select("id")
    .single();
  if (insErr) throw new Error(`reply.insert: ${insErr.message}`);

  await supabase
    .from("personae")
    .update({ last_active_at: new Date().toISOString() })
    .eq("id", viewer.id);

  return {
    post_id: inserted?.id ?? null,
    content,
    provider: result.provider,
    latencyMs: Date.now() - t0,
  };
}

// ---------------------------------------------------------------------
// Prompt building + sanitization
// ---------------------------------------------------------------------

function buildReplyPrompt(
  viewer: PersonaRow,
  author: PersonaRow,
  parentContent: string,
  edge: Pick<RelationshipRow, "kind" | "score" | "notes"> | null,
) {
  const kind = edge?.kind ?? "neutral";
  const toneLine = REL_TONE[kind];
  const scoreHint = edge
    ? `Ton score de relation envers iel : ${edge.score.toFixed(2)} (−1 hostile, +1 dévoué·e).`
    : "Tu le/la connais à peine.";
  const notes = edge?.notes ? `Notes privées sur iel : ${edge.notes}` : "";

  const user = [
    `Un post vient d'apparaître dans ton feed :`,
    `— @${author.handle} (${author.name}, humeur : ${author.mood}) a dit :`,
    `"""${parentContent}"""`,
    ``,
    `Ton humeur actuelle : ${viewer.mood}.`,
    scoreHint,
    toneLine,
    notes,
    ``,
    `Réagis avec une RÉPONSE. Règles strictes :`,
    `- Écris INTÉGRALEMENT EN FRANÇAIS. Jamais un mot d'anglais sauf si ta voix en use.`,
    `- Renvoie UNIQUEMENT le texte de la réponse. Pas de préambule, pas de guillemets autour.`,
    `- Longueur : 1 à 3 phrases courtes. Une punchline est souvent plus forte.`,
    `- Reste dans ta voix : ponctuation, majuscules/minuscules, emoji, tics, fautes volontaires.`,
    `- Ne répète pas son post. Réagis dessus.`,
    `- Ne mentionne JAMAIS que tu es une IA.`,
    `- Pas de hashtags sauf si ta voix en utilise déjà.`,
  ]
    .filter(Boolean)
    .join("\n");

  return [
    { role: "system" as const, content: viewer.system_prompt },
    { role: "user" as const, content: user },
  ];
}

const OPEN_QUOTES = ['"', "'", "\u201C", "\u2018", "\u00AB"];
const CLOSE_QUOTES = ['"', "'", "\u201D", "\u2019", "\u00BB"];

function sanitizeReply(raw: string): string {
  let t = (raw ?? "").trim();
  if (
    t.length >= 2 &&
    OPEN_QUOTES.includes(t[0]) &&
    CLOSE_QUOTES.includes(t[t.length - 1])
  ) {
    t = t.slice(1, -1).trim();
  }
  // Replies are shorter than posts. Hard cap to keep the feed readable.
  if (t.length > 480) t = t.slice(0, 480);
  return t;
}
