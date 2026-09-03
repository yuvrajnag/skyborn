"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import { Button, ErrorNote } from "@/components/ui";
import { revokeGrantAction } from "@/server/consent-actions";
import type { FormState } from "@/server/actions";

function Submit() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="secondary" disabled={pending}>
      {pending ? "Revoking…" : "Revoke"}
    </Button>
  );
}

/** One tap, and every token issued off this grant dies with it. */
export function RevokeButton({ grantId }: { grantId: string }) {
  const [state, action] = useActionState<FormState, FormData>(revokeGrantAction, undefined);

  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="grantId" value={grantId} />
      <Submit />
      {state?.error ? <ErrorNote>{state.error}</ErrorNote> : null}
    </form>
  );
}
