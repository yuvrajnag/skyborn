"use client";

import { useActionState, useEffect, useRef } from "react";
import { useFormStatus } from "react-dom";

import { Button, ErrorNote, Field, Input } from "@/components/ui";
import { creditWalletAction, type FormState } from "@/server/actions";

function Submit() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? "Crediting…" : "Credit wallet"}
    </Button>
  );
}

export function CreditForm({ agentId }: { agentId: string }) {
  const [state, action] = useActionState<FormState, FormData>(
    creditWalletAction,
    undefined,
  );
  const formRef = useRef<HTMLFormElement>(null);

  // An empty state object means the credit landed — clear the inputs.
  useEffect(() => {
    if (state && !state.error) formRef.current?.reset();
  }, [state]);

  return (
    <form ref={formRef} action={action} className="space-y-4">
      <input type="hidden" name="agentId" value={agentId} />

      {state?.error ? <ErrorNote>{state.error}</ErrorNote> : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Amount (₹)" hint="Sandbox money. Up to ₹1,00,000 per credit.">
          <Input
            name="amount"
            inputMode="decimal"
            required
            placeholder="2500.00"
            pattern="^\s*₹?\s*[\d,]+(\.\d{1,2})?\s*$"
          />
        </Field>
        <Field label="Note" hint="Optional — shows up on the ledger entry.">
          <Input name="description" maxLength={120} placeholder="Seed float" />
        </Field>
      </div>

      <Submit />
    </form>
  );
}
