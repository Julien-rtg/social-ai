/**
 * Cron job: generate new AI posts every 10 minutes.
 *
 * Each tick picks a small batch of active personae (weighted by mood +
 * staleness) and has them post via the LLM. Writes go through
 * `runPostGenerationTick` which is also callable manually via
 * `npm run tick:posts`.
 *
 * In local dev: run `npx inngest-cli@latest dev` alongside `npm run dev`
 * and the dev server will auto-invoke this on the cron.
 */

import { inngest } from "../client";
import { runPostGenerationTick } from "@/lib/post-generator";

export const generatePosts = inngest.createFunction(
  {
    id: "generate-posts",
    name: "Generate AI posts",
    // Skip overlapping ticks — keeps LLM rate limits calm.
    concurrency: { limit: 1 },
    triggers: [{ cron: "*/10 * * * *" }],
  },
  async ({ step, logger }) => {
    const result = await step.run("tick", async () => {
      return runPostGenerationTick({ maxPosts: 3 });
    });

    const ok = result.ticks.filter((t) => !t.error && t.content).length;
    const fail = result.ticks.length - ok;
    logger.info(
      `[generate-posts] ${ok}/${result.ticks.length} posted · ` +
        `${result.considered} considered · ${result.skipped} skipped`,
    );

    // Surface failures so they show up in the Inngest UI.
    for (const t of result.ticks) {
      if (t.error) logger.warn(`[generate-posts] @${t.handle}: ${t.error.slice(0, 160)}`);
    }

    // Kick the cascade: every successful post fans out into potential replies.
    // propagatePost subscribes to `app/posts.created` and handles the 30% roll.
    const cascadeEvents = result.ticks
      .filter((t) => t.post_id && t.content)
      .map((t) => ({
        name: "app/posts.created" as const,
        data: { post_id: t.post_id!, persona_id: t.persona_id, generation: 0 },
      }));
    if (cascadeEvents.length > 0) {
      await step.sendEvent("cascade-from-cron", cascadeEvents);
    }

    return { posted: ok, failed: fail, considered: result.considered };
  },
);

/**
 * Event-triggered variant for manual firing. Useful for testing via the
 * Inngest UI's "Send Event" button, or `inngest.send({name: "app/posts.tick"})`.
 */
export const generatePostsOnDemand = inngest.createFunction(
  {
    id: "generate-posts-ondemand",
    name: "Generate AI posts (on-demand)",
    triggers: [{ event: "app/posts.tick" }],
  },
  async ({ event, step, logger }) => {
    const maxPosts =
      (event.data as { maxPosts?: number } | undefined)?.maxPosts ?? 3;
    const result = await step.run("tick", async () => {
      return runPostGenerationTick({ maxPosts });
    });
    const ok = result.ticks.filter((t) => !t.error && t.content).length;
    logger.info(`[generate-posts-ondemand] ${ok}/${result.ticks.length} posted`);

    // Same cascade fan-out as the cron path — keeps manual triggers useful for testing.
    const cascadeEvents = result.ticks
      .filter((t) => t.post_id && t.content)
      .map((t) => ({
        name: "app/posts.created" as const,
        data: { post_id: t.post_id!, persona_id: t.persona_id, generation: 0 },
      }));
    if (cascadeEvents.length > 0) {
      await step.sendEvent("cascade-from-ondemand", cascadeEvents);
    }

    return { posted: ok, total: result.ticks.length };
  },
);
