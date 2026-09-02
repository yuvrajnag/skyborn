"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import { Button, ErrorNote, Field, Input } from "@/components/ui";
import { approveOAuthAction, denyOAuthAction } from "@/server/oauth-actions";
import type { FormState } from "@/server/actions";

function Submit({ label, variant }: { label: string; variant: "primary" | "secondary" }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant={variant} disabled={pending}>
      {pending ? "Working…" : label}
    </Button>
  );
}

export function AuthorizeForm({
  agents,
  hidden,
  defaultCapPaise,
}: {
  agents: Array<{ id: string; name: string; handle: string }>;
  hidden: Record<string, string>;
  defaultCapPaise: string;
}) {
  const [approveState, approve] = useActionState<FormState, FormData>(
    approveOAuthAction,
    undefined,
  );
  const [denyState, deny] = useActionState<FormState, FormData>(denyOAuthAction, undefined);
  const error = approveState?.error ?? denyState?.error;

  const hiddenFields = Object.entries(hidden).map(([name, value]) => (
    <input key={name} type="hidden" name={name} value={value} />
  ));

  return (
    <div className="space-y-5">
      {error ? <ErrorNote>{error}</ErrorNote> : null}

      <form action={approve} className="space-y-5">
        {hiddenFields}

        <Field label="Which agent" hint="The app will act as this agent, and only this one.">
          <select
            name="agentId"
            required
            className="border-line bg-ink-raised text-text w-full rounded-lg border px-3 py-2 text-sm outline-none focus:border-line-hi"
          >
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name} — {agent.handle}
              </option>
            ))}
          </select>
        </Field>

        <Field
          label="Spending cap (paise)"
          hint="Enforced on every payment, server-side. Leave blank for no cap."
        >
          <Input
            name="spendingCapPaise"
            inputMode="numeric"
            pattern="^\d*$"
            defaultValue={defaultCapPaise}
            placeholder="200000"
          />
        </Field>

        <Submit label="Approve" variant="primary" />
      </form>

      <form action={deny}>
        {hiddenFields}
        <Submit label="Deny" variant="secondary" />
      </form>
    </div>
  );
}
