/**
 * Quick sanity check on seeded personae.
 *   npm exec tsx -- --env-file=.env.local scripts/verify-personae.ts
 */
import { createAdminClient } from "../lib/supabase/admin";

async function main() {
  const supabase = createAdminClient();

  const { count, error: cErr } = await supabase
    .from("personae")
    .select("*", { count: "exact", head: true });
  if (cErr) throw cErr;
  console.log(`rows in personae: ${count}`);

  const { data, error } = await supabase
    .from("personae")
    .select("handle, name, archetype, mood, avatar_url, bio")
    .order("created_at", { ascending: false })
    .limit(3);
  if (error) throw error;

  console.log("\nlast 3 inserted:");
  for (const p of data ?? []) {
    console.log(`  @${p.handle} — ${p.name} [${p.archetype}] mood=${p.mood}`);
    console.log(`    bio: ${p.bio}`);
  }

  // Ping first avatar URL
  if (data && data[0]) {
    console.log(`\npinging avatar: ${data[0].avatar_url.slice(0, 100)}…`);
    const t0 = Date.now();
    const res = await fetch(data[0].avatar_url, { method: "HEAD" });
    console.log(`  → ${res.status} ${res.headers.get("content-type")} in ${Date.now() - t0}ms`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
