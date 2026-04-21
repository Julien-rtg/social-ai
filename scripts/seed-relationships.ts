/**
 * Seed the `relationships` table with a sparse directed graph between personae.
 *
 * Each persona picks 3-5 others they'd have the STRONGEST reactions to
 * (crush, rival, friend, beef). This pre-wires the cast for drama — the
 * remaining neutral edges emerge organically through posts/comments.
 *
 * Usage:
 *   npm run seed:relationships                  # uses all active personae
 *   npm run seed:relationships -- --dry         # preview without writing
 *   npm run seed:relationships -- --concurrency 3
 *
 * Idempotent: upsert on unique (from_persona_id, to_persona_id) with
 * ignoreDuplicates — skips pairs that already have an edge.
 */

import { createAdminClient } from "../lib/supabase/admin";
import { generateJson } from "../lib/llm";
import { pMap } from "../lib/persona";
import type { PersonaRow, RelationshipKind } from "../lib/db/types";

function parseArgs(): { dry: boolean; concurrency: number; edgesPer: number; onlyMissing: boolean } {
  const args = process.argv.slice(2);
  let dry = false;
  let concurrency = 1; // Sequential by default — relationship edges hit RPM limits fast
  let edgesPer = 4;
  let onlyMissing = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--dry" || args[i] === "--dry-run") dry = true;
    else if (args[i] === "--concurrency" || args[i] === "-c") concurrency = parseInt(args[++i], 10);
    else if (args[i] === "--edges" || args[i] === "-e") edgesPer = parseInt(args[++i], 10);
    else if (args[i] === "--only-missing") onlyMissing = true;
  }
  if (!Number.isFinite(concurrency) || concurrency < 1 || concurrency > 8) {
    throw new Error("--concurrency must be 1-8");
  }
  if (!Number.isFinite(edgesPer) || edgesPer < 1 || edgesPer > 10) {
    throw new Error("--edges must be 1-10");
  }
  return { dry, concurrency, edgesPer, onlyMissing };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function looksRateLimited(msg: string): boolean {
  const s = msg.toLowerCase();
  return (
    s.includes("429") ||
    s.includes("rate limit") ||
    s.includes("quota") ||
    s.includes("queue_exceeded") ||
    s.includes("too_many_requests")
  );
}

const VALID_KINDS: readonly RelationshipKind[] = [
  "crush",
  "love",
  "friendship",
  "rivalry",
  "hate",
  "neutral",
];

type Edge = {
  to_handle: string;
  kind: RelationshipKind;
  score: number;
  notes: string;
};

type LlmResponse = { edges: Edge[] };

/** Compact one-liner describing a persona for roster context. */
function rosterLine(p: PersonaRow): string {
  const bio = (p.bio || "").slice(0, 80).replace(/\s+/g, " ");
  return `@${p.handle} — ${p.name} [${p.archetype}]${bio ? ` — ${bio}` : ""}`;
}

function buildMessages(self: PersonaRow, roster: PersonaRow[], edgesPer: number) {
  const rosterText = roster.map(rosterLine).join("\n");
  return [
    {
      role: "system" as const,
      content: [
        "You are the social psychology engine for a fictional social network of AI personae.",
        "Your job: given a target persona and the full roster, decide who they have the STRONGEST feelings about.",
        "",
        "Rules:",
        "- Pick exactly " + edgesPer + " OTHER personae — not yourself, never duplicates.",
        "- Skew toward extremes: crushes, rivals, beef — neutral edges are boring and we want drama.",
        "- Consider archetype clashes (a wellness grifter will CLASH with a nihilist; a drama queen will orbit a softboi).",
        "- `kind` ∈ {crush, love, friendship, rivalry, hate, neutral}. Prefer non-neutral.",
        "- `score` ∈ [-1, 1]: -1 full hate, 0 neutral, +1 full love/crush. Match to kind.",
        "- `notes` = ONE sentence, in-character, explaining WHY this person makes them feel something.",
        "",
        "Output ONLY valid JSON. No markdown. No commentary.",
      ].join("\n"),
    },
    {
      role: "user" as const,
      content: [
        `TARGET PERSONA:`,
        `  handle: @${self.handle}`,
        `  name: ${self.name}`,
        `  archetype: ${self.archetype}`,
        `  bio: ${self.bio || "(none)"}`,
        self.long_term_arc ? `  arc: ${self.long_term_arc}` : "",
        `  mood: ${self.mood}`,
        "",
        `ROSTER (${roster.length} OTHERS):`,
        rosterText,
        "",
        `Return ${edgesPer} edges in this exact shape:`,
        `{"edges":[{"to_handle":"", "kind":"", "score":0, "notes":""}, ...]}`,
      ]
        .filter(Boolean)
        .join("\n"),
    },
  ];
}

function validateEdges(
  raw: Edge[],
  selfHandle: string,
  rosterHandles: Set<string>,
  edgesPer: number,
): Edge[] {
  const seen = new Set<string>();
  const out: Edge[] = [];
  for (const e of raw ?? []) {
    if (!e || typeof e !== "object") continue;
    const to = String(e.to_handle ?? "").replace(/^@/, "").toLowerCase().trim();
    if (!to || to === selfHandle) continue;
    if (!rosterHandles.has(to)) continue;
    if (seen.has(to)) continue;
    const kind = (VALID_KINDS as readonly string[]).includes(e.kind) ? (e.kind as RelationshipKind) : "neutral";
    let score = Number(e.score);
    if (!Number.isFinite(score)) score = 0;
    score = Math.max(-1, Math.min(1, score));
    const notes = String(e.notes ?? "").slice(0, 280);
    seen.add(to);
    out.push({ to_handle: to, kind, score, notes });
    if (out.length >= edgesPer + 2) break; // small safety cap
  }
  return out;
}

async function main() {
  const { dry, concurrency, edgesPer, onlyMissing } = parseArgs();

  console.log(`\n┌─ Relationship seeder`);
  console.log(`│  edges/persona: ${edgesPer}`);
  console.log(`│  concurrency:   ${concurrency}`);
  console.log(`│  only-missing:  ${onlyMissing}`);
  console.log(`│  mode:          ${dry ? "DRY RUN (no DB write)" : "write to Supabase"}`);
  console.log(`└────────────────────────────────────────────────────────\n`);

  const supabase = createAdminClient();

  console.log("[1/4] Fetching active personae…");
  const { data: cast, error } = await supabase
    .from("personae")
    .select("*")
    .eq("status", "active")
    .order("created_at", { ascending: true });
  if (error) throw error;
  if (!cast || cast.length < 3) {
    throw new Error(`Need ≥ 3 active personae, found ${cast?.length ?? 0}`);
  }
  console.log(`   → ${cast.length} personae loaded`);

  // If --only-missing, skip personae that already have ≥ edgesPer outgoing edges.
  let work = cast as PersonaRow[];
  if (onlyMissing) {
    const { data: existing } = await supabase
      .from("relationships")
      .select("from_persona_id");
    const counts = new Map<string, number>();
    for (const r of existing ?? []) {
      counts.set(r.from_persona_id, (counts.get(r.from_persona_id) ?? 0) + 1);
    }
    work = work.filter((p) => (counts.get(p.id) ?? 0) < edgesPer);
    console.log(`   → ${work.length} personae need edges (${cast.length - work.length} already done)`);
  }

  const byHandle = new Map((cast as PersonaRow[]).map((p) => [p.handle, p]));
  const rosterHandles = new Set(byHandle.keys());

  console.log(`\n[2/4] Generating edges per persona (Cerebras preferred, 1 retry on 429)…`);
  const results = await pMap(
    work,
    async (self, i) => {
      const roster = (cast as PersonaRow[]).filter((p) => p.handle !== self.handle);
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const { data, meta } = await generateJson<LlmResponse>(
            buildMessages(self, roster, edgesPer),
            {
              preferProvider: "cerebras",
              temperature: 0.9,
              maxTokens: 900,
              timeoutMs: 45_000,
            },
          );
          const valid = validateEdges(data.edges ?? [], self.handle, rosterHandles, edgesPer);
          console.log(
            `     ✓ [${i + 1}/${work.length}] @${self.handle} — ${valid.length} edges (${meta.provider}${attempt ? ", retry" : ""})`,
          );
          return { self, edges: valid, ok: true as const };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (attempt === 0 && looksRateLimited(msg)) {
            console.log(`     … [${i + 1}/${work.length}] @${self.handle} rate-limited, waiting 45s`);
            await sleep(45_000);
            continue;
          }
          console.log(
            `     ✗ [${i + 1}/${work.length}] @${self.handle} — ${msg.replace(/\s+/g, " ").slice(0, 240)}`,
          );
          return { self, edges: [] as Edge[], ok: false as const };
        }
      }
      return { self, edges: [] as Edge[], ok: false as const };
    },
    concurrency,
  );

  const successful = results.filter((r) => r.ok);
  const totalEdges = successful.reduce((n, r) => n + r.edges.length, 0);
  console.log(
    `   → ${successful.length}/${work.length} personae processed, ${totalEdges} edges total`,
  );

  console.log(`\n[3/4] Building rows…`);
  const rows: Array<{
    from_persona_id: string;
    to_persona_id: string;
    kind: RelationshipKind;
    score: number;
    notes: string;
  }> = [];
  const kindTally: Record<string, number> = {};
  for (const { self, edges } of successful) {
    for (const e of edges) {
      const target = byHandle.get(e.to_handle);
      if (!target) continue;
      rows.push({
        from_persona_id: self.id,
        to_persona_id: target.id,
        kind: e.kind,
        score: e.score,
        notes: e.notes,
      });
      kindTally[e.kind] = (kindTally[e.kind] ?? 0) + 1;
    }
  }
  console.log(`   → ${rows.length} edge rows prepared`);
  console.log(`   → kind breakdown: ${Object.entries(kindTally).map(([k, n]) => `${k}=${n}`).join(", ")}`);

  if (dry) {
    console.log(`\n[4/4] DRY RUN — sample 5 edges:\n`);
    for (const r of rows.slice(0, 5)) {
      const from = (cast as PersonaRow[]).find((p) => p.id === r.from_persona_id);
      const to = (cast as PersonaRow[]).find((p) => p.id === r.to_persona_id);
      console.log(`  @${from?.handle} → @${to?.handle} : ${r.kind} (${r.score.toFixed(2)})`);
      console.log(`    ${r.notes}`);
    }
    return;
  }

  console.log(`\n[4/4] Upserting into Supabase (ignore dup on from+to)…`);
  // Chunk inserts to keep payloads small.
  const CHUNK = 100;
  let written = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const { error: insErr, data: ins } = await supabase
      .from("relationships")
      .upsert(chunk, {
        onConflict: "from_persona_id,to_persona_id",
        ignoreDuplicates: true,
      })
      .select("id");
    if (insErr) {
      console.error(`   ✗ chunk ${i}-${i + chunk.length}: ${insErr.message}`);
      continue;
    }
    written += ins?.length ?? 0;
  }
  console.log(`   ✓ ${written} new edge${written === 1 ? "" : "s"} written`);

  console.log(`\n✓ Done. Check Supabase Table Editor → relationships.\n`);
}

main().catch((err) => {
  console.error("\n✗ Relationship seeder failed:", err);
  process.exit(1);
});
