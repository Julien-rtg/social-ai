/**
 * Verify Cerebras (Qwen 3 235B) still works and the env key is loaded.
 *   npx tsx --env-file=.env.local scripts/test-cerebras.ts
 */
import { generate } from "../lib/llm";

async function main() {
  console.log(`CEREBRAS_API_KEY present: ${!!process.env.CEREBRAS_API_KEY}`);
  console.log(`GROQ_API_KEY present:     ${!!process.env.GROQ_API_KEY}`);
  console.log(`GEMINI_API_KEY present:   ${!!process.env.GEMINI_API_KEY}`);

  console.log(`\nForcing Cerebras via preferProvider…`);
  const t0 = Date.now();
  const r = await generate(
    [{ role: "user", content: "Say 'hello from cerebras' in 3 words." }],
    { preferProvider: "cerebras", maxTokens: 30 },
  );
  console.log(`  provider: ${r.provider}`);
  console.log(`  model:    ${r.model}`);
  console.log(`  text:     ${r.text.trim()}`);
  console.log(`  latency:  ${Date.now() - t0}ms`);
}

main().catch((e) => {
  console.error("\n✗ Cerebras test failed:", e);
  process.exit(1);
});
