/**
 * Seed the personae table with freshly generated AI characters.
 *
 * Usage:
 *   npm run seed:personae -- --count 3        (default: 10)
 *   npm run seed:personae -- --count 10 --dry (preview, no DB write)
 *
 * Idempotent: uses upsert on `handle` with ignoreDuplicates so re-runs are safe.
 */

import { createAdminClient } from "../lib/supabase/admin";
import {
  avatarUrlFor,
  expandSeed,
  generateSeeds,
  pMap,
} from "../lib/persona";
import type { PersonaSeed } from "../lib/persona-prompts";

function parseArgs(): { count: number; dry: boolean; concurrency: number } {
  const args = process.argv.slice(2);
  let count = 10;
  let dry = false;
  let concurrency = 3; // safe under Groq 30 req/min with room for other calls
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--count" || args[i] === "-n") {
      count = parseInt(args[++i], 10);
    } else if (args[i] === "--dry" || args[i] === "--dry-run") {
      dry = true;
    } else if (args[i] === "--concurrency" || args[i] === "-c") {
      concurrency = parseInt(args[++i], 10);
    }
  }
  if (!Number.isFinite(count) || count < 1 || count > 50) {
    throw new Error("--count must be between 1 and 50");
  }
  if (!Number.isFinite(concurrency) || concurrency < 1 || concurrency > 10) {
    throw new Error("--concurrency must be between 1 and 10");
  }
  return { count, dry, concurrency };
}

function sanitizeHandle(h: string): string {
  return h.replace(/^@/, "").toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 15);
}

const VALID_MOODS = [
  "happy",
  "petty",
  "horny",
  "depressed",
  "manic",
  "neutral",
  "angry",
  "playful",
] as const;
type ValidMood = (typeof VALID_MOODS)[number];

function coerceMood(raw: unknown, handle: string): ValidMood {
  const s = String(raw ?? "").toLowerCase().trim();
  if ((VALID_MOODS as readonly string[]).includes(s)) return s as ValidMood;
  // loose mapping for common drift
  const map: Record<string, ValidMood> = {
    sad: "depressed",
    melancholy: "depressed",
    melancholic: "depressed",
    anxious: "manic",
    chaotic: "manic",
    chill: "neutral",
    calm: "neutral",
    smug: "petty",
    bitter: "petty",
    flirty: "horny",
    joyful: "happy",
    excited: "happy",
    pissed: "angry",
    irritated: "angry",
    mischievous: "playful",
  };
  if (map[s]) {
    console.log(`     ⚠ @${handle} mood "${s}" → "${map[s]}"`);
    return map[s];
  }
  console.log(`     ⚠ @${handle} mood "${s}" → "neutral" (fallback)`);
  return "neutral";
}

async function main() {
  const { count, dry, concurrency } = parseArgs();

  console.log(`\n┌─ Personae seeder`);
  console.log(`│  count:       ${count}`);
  console.log(`│  concurrency: ${concurrency}`);
  console.log(`│  mode:        ${dry ? "DRY RUN (no DB write)" : "write to Supabase"}`);
  console.log(`└────────────────────────────────────────────────────────\n`);

  // ── 1. Seeds ────────────────────────────────────────────────────────────
  console.log(`[1/4] Generating ${count} persona seeds (quality route)…`);
  const seedsRaw = await generateSeeds(count);
  const seeds: PersonaSeed[] = seedsRaw
    .map((s) => ({ ...s, handle: sanitizeHandle(s.handle) }))
    .filter((s) => s.handle.length >= 3 && s.name && s.archetype && s.hook);

  console.log(`   ✓ got ${seeds.length} valid seed${seeds.length === 1 ? "" : "s"}:`);
  for (const s of seeds) {
    console.log(`     @${s.handle.padEnd(16)} ${s.name.padEnd(24)} [${s.archetype}]`);
  }

  // Dedup by handle
  const byHandle = new Map<string, PersonaSeed>();
  for (const s of seeds) byHandle.set(s.handle, s);
  const uniqSeeds = [...byHandle.values()];
  if (uniqSeeds.length < seeds.length) {
    console.log(`   (deduped ${seeds.length - uniqSeeds.length} dup handle${seeds.length - uniqSeeds.length === 1 ? "" : "s"})`);
  }

  // ── 2. Expand ───────────────────────────────────────────────────────────
  console.log(`\n[2/4] Expanding each seed into full profile (fast route, ${concurrency} concurrent)…`);
  const expansions = await pMap(
    uniqSeeds,
    async (seed, i) => {
      try {
        const exp = await expandSeed(seed);
        console.log(`     ✓ [${i + 1}/${uniqSeeds.length}] @${seed.handle}`);
        return { seed, expansion: exp, ok: true as const };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Show full first line + 200 chars — enough to see which providers failed.
        const compact = msg.replace(/\s+/g, " ").slice(0, 240);
        console.log(`     ✗ [${i + 1}/${uniqSeeds.length}] @${seed.handle} — ${compact}`);
        return { seed, expansion: null, ok: false as const };
      }
    },
    concurrency,
  );
  const successful = expansions.filter((e): e is typeof e & { ok: true } => e.ok);
  console.log(`   → ${successful.length}/${uniqSeeds.length} expansions OK`);

  // ── 3. Build rows ───────────────────────────────────────────────────────
  console.log(`\n[3/4] Building rows…`);
  const rows = successful.map(({ seed, expansion }) => ({
    handle: seed.handle,
    name: seed.name,
    avatar_url: avatarUrlFor(seed.handle, seed.archetype),
    bio: expansion.bio,
    archetype: seed.archetype,
    system_prompt: expansion.system_prompt,
    voice_traits: expansion.voice_traits,
    opinions: expansion.opinions,
    mood: coerceMood(expansion.initial_mood, seed.handle),
    memory_summary: "",
    long_term_arc: expansion.long_term_arc ?? null,
    status: "active" as const,
  }));
  console.log(`   → ${rows.length} rows ready`);

  // ── 4. Insert ──────────────────────────────────────────────────────────
  if (dry) {
    console.log(`\n[4/4] DRY RUN — skipping DB write.\n`);
    for (const row of rows) {
      console.log(`── @${row.handle} (${row.archetype}) ──`);
      console.log(`  bio:          ${row.bio}`);
      console.log(`  mood:         ${row.mood}`);
      console.log(`  voice_traits: ${JSON.stringify(row.voice_traits)}`);
      console.log(`  opinions:     ${Object.keys(row.opinions).length} topics`);
      console.log(`  sys_prompt:   ${row.system_prompt.length} chars`);
      console.log(`  long_arc:     ${row.long_term_arc?.slice(0, 120) ?? "(none)"}`);
      console.log("");
    }
    return;
  }

  console.log(`\n[4/4] Upserting into Supabase (on conflict do nothing on handle)…`);
  const supabase = createAdminClient();
  const { data: inserted, error } = await supabase
    .from("personae")
    .upsert(rows, { onConflict: "handle", ignoreDuplicates: true })
    .select("id, handle, name, archetype");

  if (error) {
    console.error(`   ✗ Supabase error: ${error.message}`);
    process.exit(1);
  }

  console.log(`   ✓ upserted. ${inserted?.length ?? 0} new row${inserted?.length === 1 ? "" : "s"} written.`);
  if (inserted && inserted.length > 0) {
    for (const row of inserted) {
      console.log(`     ${row.id.slice(0, 8)}… @${row.handle} (${row.archetype})`);
    }
  }

  console.log(`\n✓ Done. Check the Supabase Table Editor → personae.\n`);
}

main().catch((err) => {
  console.error("\n✗ Seeder failed:", err);
  process.exit(1);
});
