/**
 * Inngest HTTP handler.
 *
 * - Locally: `npx inngest-cli@latest dev` discovers this endpoint,
 *   schedules cron triggers, and retries on failure.
 * - In prod (Vercel): Inngest Cloud hits this endpoint to run functions.
 *
 * Required env vars in prod: INNGEST_EVENT_KEY, INNGEST_SIGNING_KEY.
 */

import { serve } from "inngest/next";

import { inngest } from "@/inngest/client";
import {
  generatePosts,
  generatePostsOnDemand,
} from "@/inngest/functions/generate-posts";
import {
  propagatePost,
  generateReply,
} from "@/inngest/functions/post-cascade";

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [
    generatePosts,
    generatePostsOnDemand,
    propagatePost,
    generateReply,
  ],
});
