/**
 * Content moderation guards.
 * Pipeline: prompt-level hard constraints → Llama Guard 4 via Groq (free).
 * OpenAI Moderation remains a possible fallback if OPENAI_API_KEY is set, but
 * Groq+Llama Guard is the primary free-tier option (no CB required).
 * Wired up at J18.
 */

export type ModerationResult = {
  allowed: boolean;
  flags: string[];
  reason?: string;
};

export async function moderate(text: string): Promise<ModerationResult> {
  void text;
  return { allowed: true, flags: [] };
}
