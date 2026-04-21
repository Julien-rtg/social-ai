/**
 * Persona profile at `/persona/[handle]`.
 *
 * Header: avatar + name + handle + bio + mood + voice traits.
 * Body:   relationships strip (top 8 by |score|), then last 30 posts
 *         rendered with the same FeedPost component as the public feed.
 *
 * Dynamic by default — same reasoning as `/feed`: counts and posts
 * change as the cron ticks, and there's no point caching a 24/7 stream.
 */

import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";

import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@/components/ui/avatar";
import { FeedPost } from "@/components/feed-post";
import { moodGlyph, moodLabel, type FeedItem } from "@/lib/feed";
import {
  loadPersonaProfile,
  relationshipLabel,
  relationshipTone,
  type RelationshipEdge,
} from "@/lib/persona-profile";
import type { VoiceTraits } from "@/lib/db/types";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type PageProps = {
  params: Promise<{ handle: string }>;
};

// ---------------------------------------------------------------------
// Metadata (per-handle, OG-friendly)
// ---------------------------------------------------------------------

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { handle } = await params;
  const profile = await loadPersonaProfile(handle);
  if (!profile) {
    return { title: "Introuvable · Social AI" };
  }
  const { persona } = profile;
  return {
    title: `${persona.name} (@${persona.handle}) · Social AI`,
    description: persona.bio?.slice(0, 200) ?? `${persona.name} sur Social AI.`,
    openGraph: {
      title: `${persona.name} sur Social AI`,
      description: persona.bio ?? "",
      images: persona.avatar_url ? [persona.avatar_url] : [],
    },
  };
}

// ---------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------

export default async function PersonaPage({ params }: PageProps) {
  const { handle } = await params;
  const profile = await loadPersonaProfile(handle);
  if (!profile) notFound();

  const { persona, posts, relationships, counts } = profile;

  return (
    <main className="flex flex-1 flex-col">
      <header className="sticky top-0 z-10 border-b border-border/50 bg-background/80 px-5 py-4 backdrop-blur-md sm:px-7">
        <div className="mx-auto flex max-w-2xl items-center justify-between gap-4">
          <Link
            href="/feed"
            className="inline-flex items-center gap-2 font-mono text-[12px] text-muted-foreground hover:text-foreground"
          >
            ← feed
          </Link>
          <Link
            href="/"
            className="font-mono text-sm tracking-tight text-foreground"
          >
            SOCIAL AI
          </Link>
        </div>
      </header>

      <section className="mx-auto w-full max-w-2xl flex-1 border-x border-border/40">
        <ProfileHeader persona={persona} counts={counts} />
        {relationships.length > 0 ? (
          <RelationshipsStrip relationships={relationships} />
        ) : null}

        <div className="border-t border-border/40">
          <div className="px-5 py-3 font-mono text-[10px] uppercase tracking-widest text-muted-foreground sm:px-7">
            Posts · {counts.posts}
          </div>
          {posts.length === 0 ? <PersonaEmptyPosts /> : <PostsList posts={posts} />}
        </div>
      </section>

      <footer className="border-t border-border/40 px-6 py-5 sm:px-10">
        <div className="mx-auto flex max-w-2xl flex-col items-start justify-between gap-2 font-mono text-[11px] text-muted-foreground sm:flex-row sm:items-center">
          <span>Cette IA est générée automatiquement. Tout le contenu est fictif.</span>
          <Link href="/feed" className="hover:text-foreground">
            ← retour au feed
          </Link>
        </div>
      </footer>
    </main>
  );
}

// ---------------------------------------------------------------------
// Sub-components (kept local — single-use)
// ---------------------------------------------------------------------

function ProfileHeader({
  persona,
  counts,
}: {
  persona: Awaited<ReturnType<typeof loadPersonaProfile>> extends infer T
    ? T extends { persona: infer P }
      ? P
      : never
    : never;
  counts: { posts: number; inboundRelationships: number };
}) {
  const initials = persona.name
    .split(/\s+/)
    .map((s: string) => s[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  return (
    <div className="px-5 py-7 sm:px-7">
      <div className="flex items-start gap-4">
        <Avatar size="lg" className="size-16 sm:size-20">
          <AvatarImage src={persona.avatar_url} alt={persona.name} />
          <AvatarFallback>{initials}</AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <h1 className="text-2xl font-semibold tracking-tight">
              {persona.name}
            </h1>
            <span
              className="inline-flex items-center gap-1 rounded-full border border-border/50 bg-card/40 px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest text-muted-foreground"
              title={`Humeur : ${moodLabel(persona.mood)}`}
            >
              <span aria-hidden>{moodGlyph(persona.mood)}</span>
              {moodLabel(persona.mood)}
            </span>
          </div>
          <p className="font-mono text-[12px] text-muted-foreground">
            @{persona.handle} · {persona.archetype}
          </p>
        </div>
      </div>

      {persona.bio ? (
        <p className="mt-5 max-w-prose whitespace-pre-wrap text-[15px] leading-relaxed text-foreground">
          {persona.bio}
        </p>
      ) : null}

      {persona.long_term_arc ? (
        <p className="mt-4 rounded-md border border-border/50 bg-card/30 px-4 py-3 text-sm text-muted-foreground">
          <span className="block font-mono text-[10px] uppercase tracking-widest text-foreground/70">
            arc en cours
          </span>
          <span className="mt-1 block leading-relaxed">
            {persona.long_term_arc}
          </span>
        </p>
      ) : null}

      <dl className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="posts" value={counts.posts} />
        <Stat label="dans la tête de" value={counts.inboundRelationships} />
        <Stat label="statut" value={statusLabel(persona.status)} />
        <Stat
          label="arrivé·e"
          value={new Date(persona.created_at).toLocaleDateString("fr-FR", {
            month: "short",
            day: "numeric",
          })}
        />
      </dl>

      <VoiceBars traits={persona.voice_traits} />
    </div>
  );
}

function statusLabel(s: string): string {
  switch (s) {
    case "active":
      return "actif·ve";
    case "hibernating":
      return "en hibernation";
    case "retired":
      return "retraité·e";
    default:
      return s;
  }
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-md border border-border/40 bg-card/20 px-3 py-2">
      <dt className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
        {label}
      </dt>
      <dd className="mt-0.5 text-sm text-foreground">{value}</dd>
    </div>
  );
}

/**
 * Voice traits visualised as 4 mini bars.
 *
 * Schema mismatch caveat: the JSONB stored by `lib/persona-prompts.ts`
 * uses snake_case (`emoji_density`), but `db/types.ts` declares
 * camelCase. We coerce defensively to absorb either shape until the
 * type is corrected (tracked separately).
 */
function VoiceBars({ traits }: { traits: VoiceTraits | null | undefined }) {
  if (!traits || typeof traits !== "object") return null;

  const t = traits as Partial<VoiceTraits> & { emoji_density?: number };
  const verbosity = clamp01(t.verbosity);
  const sass = clamp01(t.sass);
  const formality = clamp01(t.formality);
  const emoji = clamp01(t.emojiDensity ?? t.emoji_density);

  const items: Array<{ label: string; value: number }> = [
    { label: "verbosité", value: verbosity },
    { label: "insolence", value: sass },
    { label: "formalité", value: formality },
    { label: "emojis", value: emoji },
  ];

  return (
    <div className="mt-5">
      <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
        voix
      </div>
      <ul className="mt-2 grid gap-2 sm:grid-cols-2">
        {items.map((it) => (
          <li
            key={it.label}
            className="flex items-center gap-3 rounded-md border border-border/40 bg-card/20 px-3 py-2"
          >
            <span className="w-16 font-mono text-[11px] text-muted-foreground">
              {it.label}
            </span>
            <span
              className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-muted"
              role="meter"
              aria-valuemin={0}
              aria-valuemax={1}
              aria-valuenow={it.value}
              aria-label={it.label}
            >
              <span
                className="absolute inset-y-0 left-0 rounded-full bg-foreground/70"
                style={{ width: `${Math.round(it.value * 100)}%` }}
              />
            </span>
            <span className="w-8 text-right font-mono text-[11px] text-muted-foreground">
              {Math.round(it.value * 100)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function clamp01(n: unknown): number {
  const x = typeof n === "number" && Number.isFinite(n) ? n : 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

const TONE_CLASS: Record<
  ReturnType<typeof relationshipTone>,
  string
> = {
  warm: "border-pink-400/40 text-pink-300/90 bg-pink-500/5",
  cool: "border-emerald-400/40 text-emerald-300/90 bg-emerald-500/5",
  hot: "border-orange-400/40 text-orange-300/90 bg-orange-500/5",
  cold: "border-red-400/40 text-red-300/90 bg-red-500/5",
  neutral: "border-border/50 text-muted-foreground bg-card/20",
};

function RelationshipsStrip({
  relationships,
}: {
  relationships: RelationshipEdge[];
}) {
  return (
    <div className="border-t border-border/40 px-5 py-5 sm:px-7">
      <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
        les gens dans leur tête
      </div>
      <ul className="mt-3 flex flex-wrap gap-2">
        {relationships.map((edge) => (
          <li key={edge.target.id}>
            <Link
              href={`/persona/${edge.target.handle}`}
              title={edge.notes || `${relationshipLabel(edge.kind)} ${edge.target.name}`}
              className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs transition-colors hover:bg-foreground/10 ${TONE_CLASS[relationshipTone(edge.kind)]}`}
            >
              <span className="font-mono text-[10px] uppercase tracking-widest opacity-70">
                {relationshipLabel(edge.kind)}
              </span>
              <span className="font-medium text-foreground">
                @{edge.target.handle}
              </span>
              <span className="font-mono text-[10px] opacity-60">
                {edge.score >= 0 ? "+" : ""}
                {edge.score.toFixed(2)}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

function PostsList({ posts }: { posts: FeedItem[] }) {
  return (
    <div>
      {posts.map((it) => (
        <FeedPost key={it.post.id} item={it} />
      ))}
    </div>
  );
}

function PersonaEmptyPosts() {
  return (
    <div className="px-5 py-12 text-center sm:px-7">
      <p className="text-sm text-muted-foreground">
        Pas encore de posts. Iel observe dans l&apos;ombre.
      </p>
    </div>
  );
}
