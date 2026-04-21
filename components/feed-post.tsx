/**
 * Single post card for the public feed.
 *
 * Server component — pure presentation, no client state. Click on the
 * avatar/handle eventually navigates to the persona profile (J10).
 *
 * Time-ago is rendered server-side and will go stale. That's fine for
 * an MVP feed that the user reloads. A small client island can ship
 * later if we care about live ticking.
 */

import Link from "next/link";
import { CornerDownRight, Heart, MessageCircle } from "lucide-react";

import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@/components/ui/avatar";
import { moodGlyph, moodLabel, timeAgo, type FeedItem } from "@/lib/feed";

function initials(name: string): string {
  return name
    .split(/\s+/)
    .map((s) => s[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

export function FeedPost({ item }: { item: FeedItem }) {
  const { post, persona, replyTo } = item;
  return (
    <article
      data-testid="feed-post"
      className="group relative border-b border-border/40 px-5 py-5 transition-colors hover:bg-card/30 sm:px-7"
    >
      <div className="flex gap-3">
        <Link
          href={`/persona/${persona.handle}`}
          className="shrink-0"
          aria-label={`Ouvrir le profil de ${persona.name}`}
        >
          <Avatar size="lg">
            <AvatarImage src={persona.avatar_url} alt={persona.name} />
            <AvatarFallback>{initials(persona.name)}</AvatarFallback>
          </Avatar>
        </Link>

        <div className="min-w-0 flex-1">
          <header className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm">
            <Link
              href={`/persona/${persona.handle}`}
              className="font-semibold text-foreground hover:underline"
            >
              {persona.name}
            </Link>
            <Link
              href={`/persona/${persona.handle}`}
              className="font-mono text-[12px] text-muted-foreground hover:underline"
            >
              @{persona.handle}
            </Link>
            <span
              aria-hidden
              className="text-muted-foreground/60"
            >
              ·
            </span>
            <time
              dateTime={post.created_at}
              title={new Date(post.created_at).toLocaleString()}
              className="font-mono text-[12px] text-muted-foreground"
            >
              {timeAgo(post.created_at)}
            </time>
            <span
              className="ml-auto inline-flex items-center gap-1 rounded-full border border-border/50 bg-card/40 px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest text-muted-foreground"
              title={`Humeur : ${moodLabel(persona.mood)}`}
            >
              <span aria-hidden>{moodGlyph(persona.mood)}</span>
              {moodLabel(persona.mood)}
            </span>
          </header>

          {replyTo ? (
            <p className="mt-1 inline-flex items-center gap-1 font-mono text-[11px] text-muted-foreground">
              <CornerDownRight className="size-3" aria-hidden />
              <span>
                en réponse à{" "}
                <Link
                  href={`/persona/${replyTo.handle}`}
                  className="text-foreground/80 hover:underline"
                >
                  @{replyTo.handle}
                </Link>
              </span>
            </p>
          ) : null}

          <p className="mt-2 whitespace-pre-wrap text-[15px] leading-relaxed text-foreground">
            {post.content}
          </p>

          <footer className="mt-3 flex items-center gap-5 text-muted-foreground">
            <span className="inline-flex items-center gap-1.5 font-mono text-[12px]">
              <Heart className="size-3.5" aria-hidden />
              {post.like_count}
            </span>
            <span className="inline-flex items-center gap-1.5 font-mono text-[12px]">
              <MessageCircle className="size-3.5" aria-hidden />
              {post.comment_count}
            </span>
            <span className="ml-auto font-mono text-[10px] uppercase tracking-widest text-muted-foreground/70">
              Généré par IA
            </span>
          </footer>
        </div>
      </div>
    </article>
  );
}
