/**
 * Smoke-test the waitlist insert path.
 * Uses the publishable (anon) key — same as the Server Action — to prove the
 * RLS "waitlist anyone insert" policy lets anonymous writes through.
 *
 *   npx tsx --env-file=.env.local scripts/test-waitlist.ts
 */
import { createClient } from "@supabase/supabase-js";
import { createAdminClient } from "../lib/supabase/admin";

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
  if (!url || !anon) throw new Error("Missing NEXT_PUBLIC_SUPABASE_* env vars.");

  const anonClient = createClient(url, anon);
  const admin = createAdminClient();

  const stamp = Date.now();
  const email = `smoke+${stamp}@personae.test`;

  console.log(`[1] insert ${email} via anon client…`);
  const { error: e1 } = await anonClient.from("waitlist").insert({
    email,
    source: "smoke-test",
    user_agent: "tsx-smoke-script",
  });
  if (e1) {
    console.error(`    ✗ insert failed: ${e1.code} ${e1.message}`);
    process.exit(1);
  }
  console.log(`    ✓ inserted`);

  console.log(`[2] insert the SAME email again (expecting 23505)…`);
  const { error: e2 } = await anonClient.from("waitlist").insert({
    email,
    source: "smoke-test",
  });
  if (e2?.code !== "23505") {
    console.error(`    ✗ expected 23505, got: ${e2?.code ?? "no error"}`);
    process.exit(1);
  }
  console.log(`    ✓ duplicate correctly rejected (${e2.code})`);

  console.log(`[3] verify row via admin select…`);
  const { data, error: e3 } = await admin
    .from("waitlist")
    .select("id, email, source, user_agent, created_at")
    .eq("email", email)
    .single();
  if (e3 || !data) {
    console.error(`    ✗ select failed:`, e3);
    process.exit(1);
  }
  console.log(`    ✓ row present: id=${data.id.slice(0, 8)}… source=${data.source}`);

  console.log(`[4] verify RLS blocks read for anon (privacy)…`);
  const { data: leak, error: e4 } = await anonClient
    .from("waitlist")
    .select("email")
    .eq("email", email);
  if (e4) {
    console.log(`    ✓ anon read blocked: ${e4.code} ${e4.message}`);
  } else if (!leak || leak.length === 0) {
    console.log(`    ✓ anon read returned 0 rows (RLS filter)`);
  } else {
    console.error(`    ✗ LEAK: anon could read ${leak.length} row(s)`);
    process.exit(1);
  }

  console.log(`[5] cleanup smoke row…`);
  const { error: e5 } = await admin.from("waitlist").delete().eq("email", email);
  if (e5) console.warn(`    ⚠ cleanup failed: ${e5.message}`);
  else console.log(`    ✓ deleted`);

  console.log(`\n✓ All checks passed.`);
}

main().catch((e) => {
  console.error("\n✗ Smoke test failed:", e);
  process.exit(1);
});
