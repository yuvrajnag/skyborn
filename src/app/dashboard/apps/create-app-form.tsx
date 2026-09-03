"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import { Button, Card, ErrorNote, Input, Mono } from "@/components/ui";
import { createDevAppAction, type CreateAppState } from "@/server/consent-actions";

function Submit() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? "Creating…" : "Create app"}
    </Button>
  );
}

function Secret({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-line border-b px-5 py-4 last:border-b-0">
      <p className="text-text-dim text-xs font-medium tracking-wide uppercase">{label}</p>
      <Mono className="text-text mt-2 block break-all select-all">{value}</Mono>
    </div>
  );
}

export function CreateAppForm() {
  const [state, action] = useActionState<CreateAppState, FormData>(
    createDevAppAction,
    undefined,
  );

  return (
    <div className="space-y-5">
      <form action={action} className="space-y-3">
        <div className="flex flex-col gap-3 sm:flex-row">
          <Input
            name="name"
            required
            minLength={2}
            maxLength={60}
            placeholder="Name your app, e.g. Groceries Concierge"
            aria-label="App name"
          />
          <Submit />
        </div>
        {state?.error ? <ErrorNote>{state.error}</ErrorNote> : null}
      </form>

      {state?.created ? (
        <Card>
          <div className="border-line border-b px-5 py-4">
            <p className="text-text text-sm font-medium">{state.created.name} created</p>
            <p className="text-text-dim mt-1 text-sm">
              Copy these now. Only their hashes are stored, so this is the one time
              they can be shown.
            </p>
          </div>
          <Secret label="Client ID" value={state.created.clientId} />
          <Secret label="Client secret" value={state.created.clientSecret} />
          <Secret label="Sandbox key secret" value={state.created.sandboxKeySecret} />
        </Card>
      ) : null}
    </div>
  );
}
