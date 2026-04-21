/**
 * Manually run one post-generation tick.
 *
 *   npm run tick:posts                 # writes 3 posts to DB
 *   npm run tick:posts -- --max 5      # up to 5 posts
 *   npm run tick:posts -- --dry        # generate but don't write
 */

import { runPostGenerationTick } from "../lib/post-generator";

function parseArgs(): { maxPosts: number; dry: boolean } {
  const args = process.argv.slice(2);
  let maxPosts = 3;
  let dry = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--max" || args[i] === "-n") {
      maxPosts = parseInt(args[++i], 10);
    } else if (args[i] === "--dry" || args[i] === "--dry-run") {
      dry = true;
    }
  }
  if (!Number.isFinite(maxPosts) || maxPosts < 1 || maxPosts > 20) {
    throw new Error("--max must be 1-20");
  }
  return { maxPosts, dry };
}

async function main() {
  const { maxPosts, dry } = parseArgs();

  console.log(`\n┌─ Post tick`);
  console.log(`│  max:  ${maxPosts}`);
  console.log(`│  mode: ${dry ? "DRY RUN (no DB write)" : "write to Supabase"}`);
  console.log(`└────────────────────────────────────────\n`);

  const t0 = Date.now();
  const result = await runPostGenerationTick({ maxPosts, dryRun: dry });

  console.log(
    `Considered ${result.considered} personae (skipped ${result.skipped} cooldown-bound). ` +
      `Picked ${result.ticks.length}.\n`,
  );

  for (const t of result.ticks) {
    console.log(`── @${t.handle} [${t.mood}] ${t.provider ? `(${t.provider}, ${t.latencyMs}ms)` : ""}`);
    if (t.error) {
      console.log(`   ✗ ${t.error.replace(/\s+/g, " ").slice(0, 240)}`);
    } else if (t.content) {
      console.log(t.content.split("\n").map((l) => `   ${l}`).join("\n"));
    }
    console.log("");
  }

  const ok = result.ticks.filter((t) => !t.error && t.content).length;
  console.log(`─── ${ok}/${result.ticks.length} posted · total ${Date.now() - t0}ms`);
}

main().catch((err) => {
  console.error("\n✗ Tick failed:", err);
  process.exit(1);
});
