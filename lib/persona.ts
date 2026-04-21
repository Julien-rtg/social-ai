/**
 * Persona runtime helpers.
 * Types are in `lib/db/types.ts` (PersonaRow matches the DB column-for-column).
 * Generation prompts are in `lib/persona-prompts.ts`.
 */

import { generateJson } from "./llm";
import {
  buildSeedMessages,
  buildExpandMessages,
  type PersonaSeed,
  type PersonaExpansion,
} from "./persona-prompts";

/** Deterministic numeric seed derived from a handle, for Pollinations avatar stability. */
export function handleToSeed(handle: string): number {
  let h = 0;
  for (let i = 0; i < handle.length; i++) {
    h = (h * 31 + handle.charCodeAt(i)) | 0;
  }
  return Math.abs(h) % 1_000_000;
}

/** Build a deterministic Pollinations avatar URL from handle + archetype. */
export function avatarUrlFor(handle: string, archetype: string): string {
  const prompt = [
    `portrait of a ${archetype}`,
    "close-up, social media avatar, character portrait",
    "moody cinematic lighting, stylized, highly detailed, film grain",
  ].join(", ");
  const seed = handleToSeed(handle);
  const params = new URLSearchParams({
    width: "512",
    height: "512",
    seed: String(seed),
    model: "flux",
    nologo: "true",
    enhance: "true",
  });
  return `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?${params.toString()}`;
}

/** Generate N persona seeds in one LLM call. Uses quality route for diversity. */
export async function generateSeeds(n: number): Promise<PersonaSeed[]> {
  const { data, meta } = await generateJson<{ personae: PersonaSeed[] }>(
    buildSeedMessages(n),
    { route: "quality", temperature: 1.0, maxTokens: Math.max(400 * n, 2000) },
  );
  if (!Array.isArray(data.personae)) {
    throw new Error(`Seed LLM (${meta.provider}) returned invalid shape: no 'personae' array`);
  }
  return data.personae;
}

/** Expand a single seed into a full persona profile. */
export async function expandSeed(seed: PersonaSeed): Promise<PersonaExpansion> {
  const { data, meta } = await generateJson<PersonaExpansion>(
    buildExpandMessages(seed),
    { route: "fast", temperature: 0.85, maxTokens: 3000 },
  );
  if (!data.system_prompt || !data.voice_traits || !data.opinions) {
    throw new Error(
      `Expansion LLM (${meta.provider}) returned invalid shape for @${seed.handle}`,
    );
  }
  return data;
}

/** Run `fn` over `items` with at most `concurrency` parallel in-flight. */
export async function pMap<T, R>(
  items: T[],
  fn: (item: T, index: number) => Promise<R>,
  concurrency = 5,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}
