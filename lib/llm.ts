/**
 * LLM router with cascading fallback: Groq → Gemini → Cerebras (default `route: "fast"`).
 *
 * Each call tries the chain in order; on rate limit, timeout, or transient error
 * it moves to the next provider. Throws only if every available provider fails.
 *
 * Free-tier limits at MVP scale:
 *  - Groq:     ~30 req/min, ~14k tokens/min on Llama 3.3 70B
 *  - Gemini:   ~1500 req/day on 2.0 Flash
 *  - Cerebras: generous free tier on Llama 3.3 70B (very fast inference)
 */

import Groq from "groq-sdk";
import { GoogleGenAI } from "@google/genai";

// ---------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------

export type Provider = "groq" | "gemini" | "cerebras";
export type Route = "fast" | "quality";

export type LlmMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type LlmOptions = {
  temperature?: number;
  maxTokens?: number;
  /** When true, ask the provider for JSON. Caller still parses. */
  json?: boolean;
  /** Default `"fast"` (Groq first). `"quality"` puts Gemini first. */
  route?: Route;
  /** Force a specific provider as first attempt; cascade still falls back. */
  preferProvider?: Provider;
  /** Per-call timeout in ms. Default 30s. */
  timeoutMs?: number;
};

export type LlmResult = {
  text: string;
  provider: Provider;
  model: string;
  tokensIn?: number;
  tokensOut?: number;
  latencyMs: number;
};

// ---------------------------------------------------------------------
// Model selection per route
// ---------------------------------------------------------------------

const MODELS: Record<Provider, string> = {
  groq: "llama-3.3-70b-versatile",
  // 2.5-flash-lite = fast, no "thinking" tokens eating budget. Use 2.5-flash for quality runs.
  gemini: "gemini-2.5-flash-lite",
  // Cerebras free tier (2026): Qwen 3 235B — confirmed accessible. Others like
  // gpt-oss-120b, zai-glm-4.7 are tier-gated. llama3.1-8b also works if we need smaller.
  cerebras: "qwen-3-235b-a22b-instruct-2507",
};

const CHAINS: Record<Route, Provider[]> = {
  fast: ["groq", "gemini", "cerebras"],
  quality: ["gemini", "groq", "cerebras"],
};

const DEFAULT_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------
// Lazy clients
// ---------------------------------------------------------------------

let groqClient: Groq | null = null;
let geminiClient: GoogleGenAI | null = null;

function getGroq(): Groq {
  if (!groqClient) {
    if (!process.env.GROQ_API_KEY) throw new Error("GROQ_API_KEY missing");
    groqClient = new Groq({ apiKey: process.env.GROQ_API_KEY });
  }
  return groqClient;
}

function getGemini(): GoogleGenAI {
  if (!geminiClient) {
    if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY missing");
    geminiClient = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  }
  return geminiClient;
}

function hasKeyFor(provider: Provider): boolean {
  switch (provider) {
    case "groq": return !!process.env.GROQ_API_KEY;
    case "gemini": return !!process.env.GEMINI_API_KEY;
    case "cerebras": return !!process.env.CEREBRAS_API_KEY;
  }
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Timeout after ${ms}ms (${label})`)),
      ms,
    );
  });
  return Promise.race([p, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}

function isTransientError(err: unknown): boolean {
  if (!err) return false;
  const e = err as { status?: number; message?: string };
  if (e.status === 429 || e.status === 503 || e.status === 502) return true;
  const msg = String(e.message ?? "").toLowerCase();
  return (
    msg.includes("rate limit") ||
    msg.includes("rate_limit") ||
    msg.includes("quota") ||
    msg.includes("resource_exhausted") ||
    msg.includes("resource exhausted") ||
    msg.includes("429") ||
    msg.includes("timeout") ||
    msg.includes("aborted") ||
    msg.includes("econn")
  );
}

// ---------------------------------------------------------------------
// Provider implementations
// ---------------------------------------------------------------------

async function callGroq(
  messages: LlmMessage[],
  options: LlmOptions,
): Promise<Omit<LlmResult, "latencyMs">> {
  const groq = getGroq();
  const completion = await groq.chat.completions.create({
    model: MODELS.groq,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    temperature: options.temperature ?? 0.8,
    max_tokens: options.maxTokens ?? 1024,
    response_format: options.json ? { type: "json_object" } : undefined,
  });

  const text = completion.choices[0]?.message?.content ?? "";
  return {
    text,
    provider: "groq",
    model: MODELS.groq,
    tokensIn: completion.usage?.prompt_tokens,
    tokensOut: completion.usage?.completion_tokens,
  };
}

async function callGemini(
  messages: LlmMessage[],
  options: LlmOptions,
): Promise<Omit<LlmResult, "latencyMs">> {
  const ai = getGemini();

  // Gemini has no "system" role — system prompts go into systemInstruction.
  const systemParts = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");

  const contents = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));

  const response = await ai.models.generateContent({
    model: MODELS.gemini,
    contents,
    config: {
      systemInstruction: systemParts || undefined,
      temperature: options.temperature ?? 0.8,
      maxOutputTokens: options.maxTokens ?? 1024,
      responseMimeType: options.json ? "application/json" : undefined,
    },
  });

  const text = response.text ?? "";
  const usage = response.usageMetadata;
  return {
    text,
    provider: "gemini",
    model: MODELS.gemini,
    tokensIn: usage?.promptTokenCount,
    tokensOut: usage?.candidatesTokenCount,
  };
}

async function callCerebras(
  messages: LlmMessage[],
  options: LlmOptions,
): Promise<Omit<LlmResult, "latencyMs">> {
  if (!process.env.CEREBRAS_API_KEY) throw new Error("CEREBRAS_API_KEY missing");

  const res = await fetch("https://api.cerebras.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.CEREBRAS_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODELS.cerebras,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      temperature: options.temperature ?? 0.8,
      max_tokens: options.maxTokens ?? 1024,
      response_format: options.json ? { type: "json_object" } : undefined,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const err = new Error(`Cerebras ${res.status}: ${body.slice(0, 200)}`) as Error & { status: number };
    err.status = res.status;
    throw err;
  }

  const data = (await res.json()) as {
    choices: { message: { content: string } }[];
    usage?: { prompt_tokens: number; completion_tokens: number };
  };

  return {
    text: data.choices[0]?.message?.content ?? "",
    provider: "cerebras",
    model: MODELS.cerebras,
    tokensIn: data.usage?.prompt_tokens,
    tokensOut: data.usage?.completion_tokens,
  };
}

const DISPATCH: Record<
  Provider,
  (messages: LlmMessage[], options: LlmOptions) => Promise<Omit<LlmResult, "latencyMs">>
> = {
  groq: callGroq,
  gemini: callGemini,
  cerebras: callCerebras,
};

// ---------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------

/** Build the provider order for this call, respecting `preferProvider`. */
function buildChain(options: LlmOptions): Provider[] {
  const route = options.route ?? "fast";
  const base = CHAINS[route];
  if (options.preferProvider) {
    const rest = base.filter((p) => p !== options.preferProvider);
    return [options.preferProvider, ...rest];
  }
  return base;
}

/** Generate text with cascading fallback. */
export async function generate(
  messages: LlmMessage[],
  options: LlmOptions = {},
): Promise<LlmResult> {
  const chain = buildChain(options);
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const errors: string[] = [];
  for (const provider of chain) {
    if (!hasKeyFor(provider)) continue;

    const start = Date.now();
    try {
      const result = await withTimeout(
        DISPATCH[provider](messages, options),
        timeout,
        provider,
      );
      return { ...result, latencyMs: Date.now() - start };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`[${provider}] ${msg}`);
      // Always continue cascading — even non-transient errors might be provider-specific.
      // Worst case, all fail and we throw the aggregate below.
      void isTransientError(err);
    }
  }

  const configured = chain.filter(hasKeyFor);
  if (configured.length === 0) {
    throw new Error(
      "No LLM provider configured — set at least one of GROQ_API_KEY, GEMINI_API_KEY, CEREBRAS_API_KEY",
    );
  }
  throw new Error(`All LLM providers failed:\n${errors.join("\n")}`);
}

/**
 * Generate JSON. Sets `json: true` and parses the response.
 * Throws on parse failure (caller can retry with stricter prompt).
 */
export async function generateJson<T = unknown>(
  messages: LlmMessage[],
  options: LlmOptions = {},
): Promise<{ data: T; meta: Omit<LlmResult, "text"> }> {
  const result = await generate(messages, { ...options, json: true });
  let data: T;
  try {
    data = JSON.parse(result.text) as T;
  } catch (err) {
    throw new Error(
      `LLM JSON parse failed (${result.provider}/${result.model}): ${
        err instanceof Error ? err.message : err
      }\nRaw text: ${result.text.slice(0, 500)}`,
    );
  }
  const { text: _omit, ...meta } = result;
  void _omit;
  return { data, meta };
}
