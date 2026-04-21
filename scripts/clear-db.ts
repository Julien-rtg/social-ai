/**
 * Nuke the entire Personae database.
 *
 * This wipes EVERY row in EVERY user-data table: content, cast, relationships,
 * humans, auth users, waitlist — everything. After running this with --yes the
 * only thing left is the schema itself (tables, indexes, triggers, RLS).
 *
 * Safety: dry-run by default. Pass --yes to actually delete.
 *
 * Usage:
 *   npm run db:clear                # dry-run, prints row counts
 *   npm run db:clear -- --yes       # nuke everything
 *
 * After a full nuke, you'll want:
 *   npm run seed:personae
 *   npm run seed:relationships
 */

import { createAdminClient } from "../lib/supabase/admin";

type TableSpec = {
  table: string;
  reason: string;
};

/**
 * Delete order respects FK dependencies top-down (children before parents).
 * Most of these cascades would fire automatically, but being explicit gives
 * us clean per-table counts in the output.
 */
const PUBLIC_TABLES: TableSpec[] = [
  { table: "ai_memories", reason: "pgvector memories" },
  { table: "storylines", reason: "drama arcs" },
  { table: "comments", reason: "post comments (human + AI)" },
  { table: "likes", reason: "post likes (human + AI)" },
  { table: "posts", reason: "feed content" },
  { table: "world_state", reason: "shared facts/topics/memes" },
  { table: "relationships", reason: "IA↔IA directed edges" },
  { table: "personae", reason: "the AI cast" },
  { table: "waitlist", reason: "landing-page emails" },
  { table: "profiles", reason: "human user profiles" },
];

function parseArgs(): { confirm: boolean } {
  const args = process.argv.slice(2);
  let confirm = false;
  for (const a of args) {
    if (a === "--yes" || a === "-y") confirm = true;
    else if (a === "--help" || a === "-h") {
      console.log(
        "usage: tsx scripts/clear-db.ts [--yes]\n" +
          "  (no flag)   dry-run, prints row counts for every table\n" +
          "  --yes       actually nuke everything (content + cast + humans + auth)",
      );
      process.exit(0);
    } else {
      console.error(`unknown flag: ${a}`);
      process.exit(2);
    }
  }
  return { confirm };
}

type Admin = ReturnType<typeof createAdminClient>;

async function countRows(supabase: Admin, table: string): Promise<number> {
  const { count, error } = await supabase
    .from(table)
    .select("*", { count: "exact", head: true });
  if (error) throw new Error(`count ${table}: ${error.message}`);
  return count ?? 0;
}

async function deleteAll(supabase: Admin, table: string): Promise<number> {
  // Supabase-js refuses an unfiltered delete. `gte created_at 1970` matches
  // every row since every table in this schema has a created_at default.
  const { error, count } = await supabase
    .from(table)
    .delete({ count: "exact" })
    .gte("created_at", "1970-01-01");
  if (error) throw new Error(`delete ${table}: ${error.message}`);
  return count ?? 0;
}

/**
 * Auth users live in the `auth` schema, which PostgREST does not expose.
 * We must use the admin API for both listing and deleting. Pagination needed
 * because listUsers returns max 1000 per page.
 */
async function countAuthUsers(supabase: Admin): Promise<number> {
  const { data, error } = await supabase.auth.admin.listUsers({
    page: 1,
    perPage: 1,
  });
  if (error) throw new Error(`count auth.users: ${error.message}`);
  // `total` isn't always present depending on SDK version — fall back to page walk.
  const total = (data as { total?: number })?.total;
  if (typeof total === "number") return total;
  return data.users?.length ?? 0;
}

async function deleteAllAuthUsers(supabase: Admin): Promise<number> {
  let deleted = 0;
  // Keep pulling page 1 until it's empty — each delete shifts the list.
  // Safety cap at 50 pages to avoid a runaway loop.
  for (let guard = 0; guard < 50; guard++) {
    const { data, error } = await supabase.auth.admin.listUsers({
      page: 1,
      perPage: 200,
    });
    if (error) throw new Error(`list auth.users: ${error.message}`);
    const users = data.users ?? [];
    if (users.length === 0) break;
    for (const u of users) {
      const { error: dErr } = await supabase.auth.admin.deleteUser(u.id);
      if (dErr) throw new Error(`delete auth.users ${u.id}: ${dErr.message}`);
      deleted++;
    }
  }
  return deleted;
}

async function main() {
  const { confirm } = parseArgs();
  const supabase = createAdminClient();

  console.log(
    `\n💥 clear-db — mode=${confirm ? "EXECUTE" : "dry-run"}`,
  );
  console.log("─".repeat(64));

  let total = 0;
  const plan: Array<{ table: string; before: number }> = [];

  for (const t of PUBLIC_TABLES) {
    const before = await countRows(supabase, t.table);
    plan.push({ table: t.table, before });
    total += before;
    console.log(
      `  ${t.table.padEnd(18)} ${String(before).padStart(6)}  — ${t.reason}`,
    );
  }

  const authBefore = await countAuthUsers(supabase);
  total += authBefore;
  console.log(
    `  ${"auth.users".padEnd(18)} ${String(authBefore).padStart(6)}  — Supabase-managed accounts`,
  );

  console.log("─".repeat(64));
  console.log(`  total rows: ${total}`);

  if (!confirm) {
    console.log(
      `\n⚠  dry-run. Re-run with --yes to actually nuke the database.\n` +
        `   Nothing will be preserved — not the cast, not the waitlist, not auth users.\n`,
    );
    return;
  }

  if (total === 0) {
    console.log(`\n✓ already empty.\n`);
    return;
  }

  console.log(`\n💣 wiping...\n`);

  let deleted = 0;
  for (const t of PUBLIC_TABLES) {
    const n = await deleteAll(supabase, t.table);
    deleted += n;
    console.log(`  ${t.table.padEnd(18)} ✓ deleted ${n}`);
  }

  const authDeleted = await deleteAllAuthUsers(supabase);
  deleted += authDeleted;
  console.log(`  ${"auth.users".padEnd(18)} ✓ deleted ${authDeleted}`);

  console.log(`\n✓ ${deleted} rows deleted. Database is empty.\n`);
  console.log(
    `next steps to get a feed back:\n` +
      `  1) npm run seed:personae\n` +
      `  2) npm run seed:relationships\n` +
      `  3) npm run dev\n`,
  );
}

main().catch((err) => {
  console.error(`\n✗ clear-db failed: ${err?.message ?? err}\n`);
  process.exit(1);
});
