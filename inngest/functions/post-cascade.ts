/**
 * IA→IA cascade (J13).
 *
 * Flow:
 *   cron generates post  ─┐
 *                         ├──► app/posts.created  ──► propagatePost
 *   a reply is persisted ─┘                           (30 % chance,
 *                                                      picks 3–5 viewers,
 *                                                      schedules replies)
 *                                                       │
 *                                                       ▼
 *                                              app/posts.reply  ──► generateReply
 *                                                                   (anti-loop,
 *                                                                    inserts reply,
 *                                                                    fires new
 *                                                                    posts.created
 *                                                                    at gen+1)
 *
 * Generational decay: the cascade chance drops sharply for each reply
 * level. Original post = 30 %, first reply = 15 %, second = 5 %, done.
 * This is the single biggest safeguard against the feed collapsing
 * into a two-persona slap-fight.
 */

import { inngest } from "../client";
import { generateReplyFor, pickReplyCandidates } from "@/lib/post-reply";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Mood } from "@/lib/db/types";

// --------- tuning knobs ---------
const CASCADE_CHANCE_BY_GEN = [0.3, 0.15, 0.05] as const; // gen 0, 1, 2
const MIN_VIEWERS = 3;
const MAX_VIEWERS = 5;
/** Each reply lands at random delay between these bounds (minutes). */
const REPLY_DELAY_MIN_SEC = 30;
const REPLY_DELAY_MAX_SEC = 8 * 60;

// ---------------------------------------------------------------------
// Event: app/posts.created  ── fan out into N scheduled replies
// ---------------------------------------------------------------------

export const propagatePost = inngest.createFunction(
  {
    id: "propagate-post",
    name: "Fan out replies for a new post",
    // Keep it bounded — the cron already limits posts per tick, but an
    // upper concurrency here prevents a stampede if we ever backfill.
    concurrency: { limit: 4 },
    triggers: [{ event: "app/posts.created" }],
  },
  async ({ event, step, logger }) => {
    const { post_id, persona_id, generation = 0 } = (event.data ?? {}) as {
      post_id?: string;
      persona_id?: string;
      generation?: number;
    };

    if (!post_id || !persona_id) {
      logger.warn(`[propagate] missing post_id or persona_id, skip`);
      return { skipped: "missing ids" };
    }

    const cascadeChance = CASCADE_CHANCE_BY_GEN[generation] ?? 0;
    if (cascadeChance <= 0) {
      return { skipped: "max cascade depth", generation };
    }

    // Deterministic per-post roll so retries don't double-fire.
    const roll = await step.run("cascade-roll", async () => Math.random());
    if (roll > cascadeChance) {
      return { skipped: "not this time", roll, cascadeChance, generation };
    }

    // Fetch author mood + pick viewers.
    const picks = await step.run("pick-viewers", async () => {
      const supabase = createAdminClient();
      const { data } = await supabase
        .from("personae")
        .select("mood")
        .eq("id", persona_id)
        .maybeSingle();
      const authorMood = (data?.mood ?? "neutral") as Mood;
      const count = Math.floor(Math.random() * (MAX_VIEWERS - MIN_VIEWERS + 1)) + MIN_VIEWERS;
      const candidates = await pickReplyCandidates(persona_id, authorMood, count);
      return candidates.map((c) => ({
        viewerId: c.viewer.id,
        handle: c.viewer.handle,
        weight: Number(c.weight.toFixed(3)),
        kind: c.edge?.kind ?? "stranger",
      }));
    });

    if (picks.length === 0) {
      return { skipped: "no viewers", generation };
    }

    // Fan out: each viewer gets its own event with a randomised delay.
    // We send them all at once (single step.sendEvent call) — Inngest
    // will schedule them thanks to the `ts` field on each payload.
    const now = Date.now();
    const replyEvents = picks.map((p, i) => {
      const delayMs =
        (REPLY_DELAY_MIN_SEC +
          Math.random() * (REPLY_DELAY_MAX_SEC - REPLY_DELAY_MIN_SEC)) *
        1000;
      // Inngest requires `ts` as int64 — Math.random() can introduce a
      // fractional ms. Floor before sending.
      const ts = Math.floor(now + delayMs + i * 1500);
      return {
        name: "app/posts.reply" as const,
        ts,
        data: {
          parent_post_id: post_id,
          parent_persona_id: persona_id,
          viewer_persona_id: p.viewerId,
          generation: generation + 1,
        },
      };
    });

    await step.sendEvent("schedule-replies", replyEvents);

    logger.info(
      `[propagate] post=${post_id.slice(0, 8)} gen=${generation} → ${picks.length} replies scheduled`,
    );
    return {
      generation,
      scheduled: picks.length,
      viewers: picks.map((p) => ({ handle: p.handle, kind: p.kind })),
    };
  },
);

// ---------------------------------------------------------------------
// Event: app/posts.reply  ── generate the reply, persist, cascade again
// ---------------------------------------------------------------------

export const generateReply = inngest.createFunction(
  {
    id: "generate-reply",
    name: "Generate a reply from a persona",
    // 2 concurrent LLM replies is enough pressure on free tiers.
    concurrency: { limit: 2 },
    triggers: [{ event: "app/posts.reply" }],
  },
  async ({ event, step, logger }) => {
    const { parent_post_id, parent_persona_id, viewer_persona_id, generation = 1 } =
      (event.data ?? {}) as {
        parent_post_id?: string;
        parent_persona_id?: string;
        viewer_persona_id?: string;
        generation?: number;
      };

    if (!parent_post_id || !parent_persona_id || !viewer_persona_id) {
      logger.warn(`[reply] missing ids, skip`);
      return { skipped: "missing ids" };
    }

    const result = await step.run("generate-reply", async () =>
      generateReplyFor({
        parentPostId: parent_post_id,
        parentPersonaId: parent_persona_id,
        viewerPersonaId: viewer_persona_id,
      }),
    );

    if (!result.post_id || !result.content) {
      logger.info(`[reply] skipped: ${result.skippedReason ?? "no content"}`);
      return { skipped: result.skippedReason ?? "empty" };
    }

    // Recurse into the cascade at +1 generation.
    await step.sendEvent("cascade-from-reply", {
      name: "app/posts.created",
      data: {
        post_id: result.post_id,
        persona_id: viewer_persona_id,
        generation,
      },
    });

    logger.info(
      `[reply] ✓ viewer=${viewer_persona_id.slice(0, 8)} gen=${generation} · ${result.provider} · ${result.latencyMs}ms`,
    );
    return {
      post_id: result.post_id,
      generation,
      latencyMs: result.latencyMs,
      provider: result.provider,
    };
  },
);
