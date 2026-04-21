/**
 * Hand-typed mirror of `db/schema.sql`.
 * Keep in sync with schema changes — or replace with Supabase CLI generation
 * once the schema stabilises (`supabase gen types typescript`).
 */

export type Mood =
  | "happy"
  | "petty"
  | "horny"
  | "depressed"
  | "manic"
  | "neutral"
  | "angry"
  | "playful";

export type PersonaStatus = "active" | "hibernating" | "retired";

export type RelationshipKind =
  | "crush"
  | "love"
  | "friendship"
  | "rivalry"
  | "hate"
  | "neutral";

export type WorldStateKind = "event" | "topic" | "meme" | "fact" | "rumor";

export type StorylineStatus = "planned" | "active" | "resolved" | "aborted";

export type VoiceTraits = {
  verbosity: number;
  sass: number;
  formality: number;
  emojiDensity: number;
};

export type StoryBeat = {
  day: number;
  description: string;
  involved: string[]; // persona ids or handles
};

// Row shapes — match `select *` from each table.
export type PersonaRow = {
  id: string;
  handle: string;
  name: string;
  avatar_url: string;
  bio: string;
  archetype: string;
  system_prompt: string;
  voice_traits: VoiceTraits;
  opinions: Record<string, number>;
  mood: Mood;
  memory_summary: string;
  long_term_arc: string | null;
  status: PersonaStatus;
  last_active_at: string;
  created_at: string;
};

export type PostRow = {
  id: string;
  persona_id: string;
  content: string;
  image_url: string | null;
  in_reply_to_post_id: string | null;
  reply_to_persona_id: string | null;
  storyline_id: string | null;
  moderation_flags: string[];
  like_count: number;
  comment_count: number;
  created_at: string;
};

export type CommentRow = {
  id: string;
  post_id: string;
  parent_comment_id: string | null;
  persona_id: string | null;
  user_id: string | null;
  content: string;
  moderation_flags: string[];
  created_at: string;
};

export type LikeRow = {
  id: string;
  post_id: string;
  persona_id: string | null;
  user_id: string | null;
  created_at: string;
};

export type RelationshipRow = {
  id: string;
  from_persona_id: string;
  to_persona_id: string;
  kind: RelationshipKind;
  score: number;
  last_interaction_at: string;
  notes: string;
  created_at: string;
};

export type AiMemoryRow = {
  id: string;
  persona_id: string;
  content: string;
  embedding: number[] | null;
  importance: number;
  related_persona_ids: string[];
  related_post_id: string | null;
  created_at: string;
};

export type WorldStateRow = {
  id: string;
  kind: WorldStateKind;
  title: string;
  description: string;
  importance: number;
  active: boolean;
  created_at: string;
  expires_at: string | null;
};

export type StorylineRow = {
  id: string;
  title: string;
  synopsis: string;
  involved_persona_ids: string[];
  story_beats: StoryBeat[];
  status: StorylineStatus;
  started_at: string | null;
  ends_at: string | null;
  created_at: string;
};

export type WaitlistRow = {
  id: string;
  email: string;
  source: string;
  user_agent: string | null;
  created_at: string;
  confirmed_at: string | null;
};

export type ProfileRow = {
  id: string;
  display_name: string | null;
  is_premium: boolean;
  created_at: string;
};

// Match-memories function return shape.
export type MemoryMatch = {
  id: string;
  content: string;
  importance: number;
  similarity: number;
  created_at: string;
};
