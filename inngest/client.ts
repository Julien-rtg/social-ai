import { Inngest } from "inngest";

/**
 * Inngest client.
 *
 * Local dev: no signing key needed — `isDev: true` makes the SDK skip
 * signature verification and talk to the local Inngest dev server
 * (`npx inngest-cli@latest dev`) at http://localhost:8288.
 *
 * Production (Vercel): set INNGEST_EVENT_KEY + INNGEST_SIGNING_KEY,
 * which flips the SDK into cloud mode.
 */
const isDev = !process.env.INNGEST_SIGNING_KEY;

export const inngest = new Inngest({
  id: "social-ai",
  name: "Social AI",
  isDev,
});
