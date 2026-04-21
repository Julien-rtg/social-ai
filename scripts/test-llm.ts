/**
 * Smoke test for the LLM cascade router.
 *
 * Run: `npm run test:llm`
 *
 * Tests, in order:
 *   1. Plain text generation through the default fast chain.
 *   2. JSON-mode generation.
 *   3. Forced "quality" route (Gemini first).
 *   4. preferProvider override on each available provider.
 */

import { generate, generateJson, type Provider } from "../lib/llm";

const PROVIDERS: Provider[] = ["groq", "gemini", "cerebras"];

function envFor(p: Provider): string {
  return p === "groq" ? "GROQ_API_KEY" : p === "gemini" ? "GEMINI_API_KEY" : "CEREBRAS_API_KEY";
}

async function main() {
  const configured = PROVIDERS.filter((p) => !!process.env[envFor(p)]);
  console.log(`\n→ Configured providers: ${configured.join(", ") || "(none)"}`);

  if (configured.length === 0) {
    console.error("\n✗ No LLM provider key set in .env.local. Add at least one of:");
    PROVIDERS.forEach((p) => console.error(`  - ${envFor(p)}`));
    process.exit(1);
  }

  // --- Test 1: plain text -------------------------------------------------
  console.log("\n[1] Plain generate (default fast chain)");
  const r1 = await generate(
    [
      { role: "system", content: "You are a sarcastic micro-influencer. One sentence only." },
      { role: "user", content: "Hot take on pineapple on pizza." },
    ],
    { temperature: 0.9, maxTokens: 80 },
  );
  console.log(`  ✓ provider=${r1.provider} model=${r1.model} latency=${r1.latencyMs}ms`);
  console.log(`  ↳ "${r1.text.trim()}"`);

  // --- Test 2: JSON mode --------------------------------------------------
  console.log("\n[2] JSON mode");
  const r2 = await generateJson<{ name: string; archetype: string; opening_line: string }>(
    [
      {
        role: "system",
        content:
          "You generate fictional AI personalities. Return only valid JSON with keys: name, archetype, opening_line.",
      },
      { role: "user", content: "Generate one drama-queen character." },
    ],
    { temperature: 0.9, maxTokens: 200 },
  );
  console.log(`  ✓ provider=${r2.meta.provider} latency=${r2.meta.latencyMs}ms`);
  console.log(`  ↳`, r2.data);

  // --- Test 3: quality route ---------------------------------------------
  if (process.env.GEMINI_API_KEY) {
    console.log("\n[3] Quality route (Gemini-first)");
    const r3 = await generate(
      [{ role: "user", content: "In 10 words, why is Twitter exhausting?" }],
      { route: "quality", maxTokens: 60 },
    );
    console.log(`  ✓ provider=${r3.provider} latency=${r3.latencyMs}ms`);
    console.log(`  ↳ "${r3.text.trim()}"`);
  }

  // --- Test 4: forced provider per available -----------------------------
  console.log("\n[4] Force each configured provider");
  for (const p of configured) {
    try {
      const r = await generate(
        [{ role: "user", content: "Say hello in one word." }],
        { preferProvider: p, maxTokens: 20 },
      );
      console.log(`  ✓ ${p.padEnd(8)} → ${r.provider}/${r.model} (${r.latencyMs}ms): "${r.text.trim()}"`);
    } catch (err) {
      console.log(`  ✗ ${p.padEnd(8)} failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  console.log("\n✓ All tests done.\n");
}

main().catch((err) => {
  console.error("\n✗ Test failed:", err);
  process.exit(1);
});
