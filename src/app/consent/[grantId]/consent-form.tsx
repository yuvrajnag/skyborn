"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import { Button, ErrorNote } from "@/components/ui";
import { approveGrantAction, denyGrantAction } from "@/server/consent-actions";
import type { FormState } from "@/server/actions";

function Submit({ label, variant }: { label: string; variant: "primary" | "secondary" }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant={variant} disabled={pending}>
      {pending ? "Working…" : label}
    </Button>
  );
}

export function ConsentForm({ grantId }: { grantId: string }) {
  const [approveState, approve] = useActionState<FormState, FormData>(
    approveGrantAction,
    undefined,
  );
  const [denyState, deny] = useActionState<FormState, FormData>(denyGrantAction, undefined);
  const error = approveState?.error ?? denyState?.error;

  return (
    <div className="space-y-4">
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      <div className="flex flex-wrap gap-3">
        <form action={approve}>
          <input type="hidden" name="grantId" value={grantId} />
          <Submit label="Approve" variant="primary" />
        </form>
        <form action={deny}>
          <input type="hidden" name="grantId" value={grantId} />
          <Submit label="Deny" variant="secondary" />
        </form>
      </div>
    </div>
  );
}
