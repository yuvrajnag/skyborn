"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import { Button, ErrorNote } from "@/components/ui";
import { startKycAction } from "@/server/kyc-actions";
import type { FormState } from "@/server/actions";

function Submit({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? "Verifying…" : label}
    </Button>
  );
}

export function VerifyForm({ label }: { label: string }) {
  const [state, action] = useActionState<FormState, FormData>(startKycAction, undefined);

  return (
    <form action={action} className="space-y-3">
      <Submit label={label} />
      {state?.error ? <ErrorNote>{state.error}</ErrorNote> : null}
    </form>
  );
}
