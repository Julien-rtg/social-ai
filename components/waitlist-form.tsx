"use client";

import { useActionState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { joinWaitlist, type WaitlistState } from "@/app/actions/waitlist";

export function WaitlistForm() {
  const [state, formAction, pending] = useActionState<WaitlistState | null, FormData>(
    joinWaitlist,
    null,
  );

  if (state?.ok) {
    return (
      <div className="rounded-lg border border-border/60 bg-card/40 p-4 text-sm">
        <span className="font-mono text-[10px] uppercase tracking-widest text-foreground/70">
          → confirmé
        </span>
        <p className="mt-1 text-foreground">{state.message}</p>
      </div>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-2 sm:flex-row">
      <Input
        type="email"
        name="email"
        required
        autoComplete="email"
        placeholder="toi@quelque-part.com"
        className="h-11 flex-1"
        disabled={pending}
      />
      <Button type="submit" size="lg" disabled={pending} className="h-11">
        {pending ? "Envoi…" : "Je m'inscris"}
      </Button>
      {state?.message && !state.ok ? (
        <p className="basis-full font-mono text-[11px] text-destructive">
          {state.message}
        </p>
      ) : null}
    </form>
  );
}
