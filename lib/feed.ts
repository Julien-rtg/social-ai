/**
 * Feed loading helpers for the public `/feed` page (RSC).
 *
 * One round-trip to Postgres: we ask for posts with the embedded persona
 * via Supabase's relational select. This is way cheaper than two queries
 * + client-side join, and the result is type-narrowed below.
 *
 * No `use cache` directive — the feed is meant to update every refresh,
 * and Next 16 server components are dynamic by default.
 */

import { createAdminClient } from "./supabase/admin";
import type { Mood, PersonaRow, PostRow } from "./db/types";

/** A persona slim enough for a feed card (no system_prompt, no opinions blob). */
export type FeedPersona = Pick<
  PersonaRow,
  "id" | "handle" | "name" | "avatar_url" | "archetype" | "mood" | "bio"
>;

/** Minimal shape of the persona being replied TO — enough to render "↪ @handle". */
export type ReplyTarget = Pick<PersonaRow, "handle" | "name">;

export type FeedItem = {
  post: Pick<
    PostRow,
    | "id"
    | "content"
    | "image_url"
    | "in_reply_to_post_id"
    | "reply_to_persona_id"
    | "like_count"
    | "comment_count"
    | "created_at"
  >;
  persona: FeedPersona;
  /** Populated when the post is a reply — cascade output from J13. */
  replyTo: ReplyTarget | null;
};

/** Fetch the latest N posts with their author persona, newest first. */
export async function loadFeed(limit = 50): Promise<FeedItem[]> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("posts")
    .select(
      `
      id, content, image_url, in_reply_to_post_id, reply_to_persona_id,
      like_count, comment_count, created_at,
      persona:personae!persona_id (
        id, handle, name, avatar_url, archetype, mood, bio
      ),
      reply_to:personae!reply_to_persona_id ( handle, name )
      `,
    )
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw new Error(`loadFeed: ${error.message}`);

  // Supabase types the embedded relation as array | object depending on FK shape.
  // Both `persona` and `reply_to` have single FKs → objects; we coerce defensively.
  const rows = (data ?? []) as Array<{
    id: string;
    content: string;
    image_url: string | null;
    in_reply_to_post_id: string | null;
    reply_to_persona_id: string | null;
    like_count: number;
    comment_count: number;
    created_at: string;
    persona: FeedPersona | FeedPersona[] | null;
    reply_to: ReplyTarget | ReplyTarget[] | null;
  }>;

  const items: FeedItem[] = [];
  for (const r of rows) {
    const persona = Array.isArray(r.persona) ? r.persona[0] : r.persona;
    if (!persona) continue; // orphaned post — skip
    const replyToRaw = Array.isArray(r.reply_to) ? r.reply_to[0] : r.reply_to;
    const replyTo = replyToRaw ?? null;
    items.push({
      post: {
        id: r.id,
        content: r.content,
        image_url: r.image_url,
        in_reply_to_post_id: r.in_reply_to_post_id,
        reply_to_persona_id: r.reply_to_persona_id,
        like_count: r.like_count,
        comment_count: r.comment_count,
        created_at: r.created_at,
      },
      persona,
      replyTo,
    });
  }
  return items;
}

/** Headline numbers for the feed header strip. One cheap aggregate query. */
export type FeedStats = {
  activePersonae: number;
  postsLast24h: number;
  totalPosts: number;
};

export async function loadFeedStats(): Promise<FeedStats> {
  const supabase = createAdminClient();
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const [activeRes, last24Res, totalRes] = await Promise.all([
    supabase
      .from("personae")
      .select("*", { count: "exact", head: true })
      .eq("status", "active"),
    supabase
      .from("posts")
      .select("*", { count: "exact", head: true })
      .gte("created_at", since),
    supabase.from("posts").select("*", { count: "exact", head: true }),
  ]);

  return {
    activePersonae: activeRes.count ?? 0,
    postsLast24h: last24Res.count ?? 0,
    totalPosts: totalRes.count ?? 0,
  };
}

// ---------------------------------------------------------------------
// Tiny formatting utilities (kept here so feed components stay dumb)
// ---------------------------------------------------------------------

/** "3m", "2h", "5d" — TikTok-style compact relative time. */
export function timeAgo(iso: string): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "";
  const sec = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const d = Math.floor(hr / 24);
  if (d < 7) return `${d}d`;
  const w = Math.floor(d / 7);
  if (w < 5) return `${w}w`;
  const mo = Math.floor(d / 30);
  return `${mo}mo`;
}

const MOOD_EMOJI: Record<Mood, string> = {
  manic: "⚡",
  petty: "🙄",
  horny: "🔥",
  angry: "😤",
  playful: "😏",
  happy: "✨",
  neutral: "·",
  depressed: "🌧",
};

export function moodGlyph(mood: Mood): string {
  return MOOD_EMOJI[mood] ?? "·";
}

/** French-facing label for the mood enum (DB values stay English). */
const MOOD_LABEL_FR: Record<Mood, string> = {
  manic: "survolté·e",
  petty: "mesquin·e",
  horny: "en chaleur",
  angry: "en colère",
  playful: "taquin·e",
  happy: "content·e",
  neutral: "neutre",
  depressed: "déprimé·e",
};

export function moodLabel(mood: Mood): string {
  return MOOD_LABEL_FR[mood] ?? mood;
}
