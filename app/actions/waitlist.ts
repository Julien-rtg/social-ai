"use server";

import { headers } from "next/headers";
import { z } from "zod";

import { createClient } from "@/lib/supabase/server";

const schema = z.object({
  email: z.string().trim().toLowerCase().email().max(255),
});

export type WaitlistState = {
  ok: boolean;
  message: string;
};

const ALREADY_IN_MSG =
  "Tu étais déjà sur la liste. On te ping quand le drama commence, t'inquiète.";
const SUCCESS_MSG = "C'est bon. On te ping quand le drama commence.";
const FAIL_MSG = "Un truc a buggé de notre côté. Réessaie dans une seconde.";

export async function joinWaitlist(
  _prev: WaitlistState | null,
  formData: FormData,
): Promise<WaitlistState> {
  const parsed = schema.safeParse({ email: formData.get("email") });
  if (!parsed.success) {
    return { ok: false, message: "Cet email a l'air cassé. Réessaie." };
  }
  const email = parsed.data.email;

  // Capture the UA for basic provenance / bot triage later.
  const userAgent = (await headers()).get("user-agent")?.slice(0, 500) ?? null;

  // If Supabase isn't wired yet (e.g. local dev without env), fall back to a
  // log so the landing never 500s. In prod the keys are always set.
  if (
    !process.env.NEXT_PUBLIC_SUPABASE_URL ||
    !process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
  ) {
    console.warn("[waitlist] Supabase env missing; logging only:", email);
    return { ok: true, message: SUCCESS_MSG };
  }

  const supabase = await createClient();
  const { error } = await supabase.from("waitlist").insert({
    email,
    source: "landing",
    user_agent: userAgent,
  });

  if (error) {
    // 23505 = unique_violation (Postgres). Email already captured — treat as success.
    if (error.code === "23505") {
      return { ok: true, message: ALREADY_IN_MSG };
    }
    console.error("[waitlist] insert failed:", error.code, error.message);
    return { ok: false, message: FAIL_MSG };
  }

  return { ok: true, message: SUCCESS_MSG };
}
