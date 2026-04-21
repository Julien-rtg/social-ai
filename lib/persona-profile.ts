/**
 * Data loaders for `/persona/[handle]` (RSC).
 *
 * One round to fetch the persona by handle, then fan out 2 queries in
 * parallel: their last N posts (with a tiny self-join so FeedPost can
 * still render them) and their outbound relationships ranked by |score|.
 *
 * Relationships are bidirectional in concept but we only show the
 * "outgoing" feelings on the profile (what THIS persona thinks of
 * others). The reverse would clutter and isn't part of the J10 brief.
 */

import { createAdminClient } from "./supabase/admin";
import type {
  PersonaRow,
  RelationshipKind,
  RelationshipRow,
} from "./db/types";
import type { FeedItem, FeedPersona, ReplyTarget } from "./feed";

export type RelationshipEdge = {
  kind: RelationshipKind;
  score: number;
  notes: string;
  target: FeedPersona;
};

export type PersonaProfile = {
  persona: PersonaRow;
  posts: FeedItem[];
  relationships: RelationshipEdge[];
  /** Counts for the header strip. */
  counts: {
    posts: number;
    inboundRelationships: number;
  };
};

/**
 * Load full profile for a handle. Returns `null` if the handle does
 * not exist (so the page can call `notFound()`).
 */
export async function loadPersonaProfile(
  handle: string,
): Promise<PersonaProfile | null> {
  const supabase = createAdminClient();
  const cleanHandle = handle.trim().toLowerCase();

  const { data: persona, error: pErr } = await supabase
    .from("personae")
    .select("*")
    .eq("handle", cleanHandle)
    .maybeSingle();

  if (pErr) throw new Error(`loadPersonaProfile.persona: ${pErr.message}`);
  if (!persona) return null;

  const personaRow = persona as PersonaRow;

  const [postsRes, relationsRes, postsCountRes, inboundCountRes] =
    await Promise.all([
      // Last 30 posts. We re-embed the persona so FeedPost can render them
      // with no schema change — yes the persona is the same on every row,
      // but it's <1 KB of duplicated payload and avoids a special-case render.
      supabase
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
        .eq("persona_id", personaRow.id)
        .order("created_at", { ascending: false })
        .limit(30),
      // Outbound relationships, top by |score|. Pull a generous slice and
      // rank client-side (Postgres ORDER BY abs(score) requires a function index).
      supabase
        .from("relationships")
        .select(
          `
          id, from_persona_id, to_persona_id, kind, score, notes, last_interaction_at, created_at,
          target:personae!to_persona_id (
            id, handle, name, avatar_url, archetype, mood, bio
          )
          `,
        )
        .eq("from_persona_id", personaRow.id)
        .limit(20),
      supabase
        .from("posts")
        .select("*", { count: "exact", head: true })
        .eq("persona_id", personaRow.id),
      supabase
        .from("relationships")
        .select("*", { count: "exact", head: true })
        .eq("to_persona_id", personaRow.id),
    ]);

  if (postsRes.error)
    throw new Error(`loadPersonaProfile.posts: ${postsRes.error.message}`);
  if (relationsRes.error)
    throw new Error(
      `loadPersonaProfile.relationships: ${relationsRes.error.message}`,
    );

  const postRows = (postsRes.data ?? []) as Array<{
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

  const posts: FeedItem[] = postRows
    .map((r) => {
      const p = Array.isArray(r.persona) ? r.persona[0] : r.persona;
      if (!p) return null;
      const replyToRaw = Array.isArray(r.reply_to) ? r.reply_to[0] : r.reply_to;
      return {
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
        persona: p,
        replyTo: replyToRaw ?? null,
      } satisfies FeedItem;
    })
    .filter((x): x is FeedItem => x !== null);

  const relationRows = (relationsRes.data ?? []) as Array<
    Pick<
      RelationshipRow,
      "id" | "kind" | "score" | "notes" | "from_persona_id" | "to_persona_id"
    > & {
      target: FeedPersona | FeedPersona[] | null;
    }
  >;

  const relationships: RelationshipEdge[] = relationRows
    .map((r) => {
      const target = Array.isArray(r.target) ? r.target[0] : r.target;
      if (!target) return null;
      return {
        kind: r.kind,
        score: r.score,
        notes: r.notes ?? "",
        target,
      } satisfies RelationshipEdge;
    })
    .filter((x): x is RelationshipEdge => x !== null)
    .sort((a, b) => Math.abs(b.score) - Math.abs(a.score))
    .slice(0, 8);

  return {
    persona: personaRow,
    posts,
    relationships,
    counts: {
      posts: postsCountRes.count ?? 0,
      inboundRelationships: inboundCountRes.count ?? 0,
    },
  };
}

// ---------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------

const RELATION_LABEL: Record<RelationshipKind, string> = {
  crush: "en crush sur",
  love: "amoureux·se de",
  friendship: "proche de",
  rivalry: "en rivalité avec",
  hate: "déteste",
  neutral: "connaît",
};

export function relationshipLabel(kind: RelationshipKind): string {
  return RELATION_LABEL[kind] ?? "connaît";
}

/** Color class hint for the relationship pill. */
export function relationshipTone(
  kind: RelationshipKind,
): "warm" | "cool" | "hot" | "cold" | "neutral" {
  switch (kind) {
    case "crush":
    case "love":
      return "warm";
    case "friendship":
      return "cool";
    case "rivalry":
      return "hot";
    case "hate":
      return "cold";
    default:
      return "neutral";
  }
}
