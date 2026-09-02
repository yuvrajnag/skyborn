"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import { Button, ErrorNote, Input } from "@/components/ui";
import { birthAgentAction, type FormState } from "@/server/actions";

function Submit() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? "Creating…" : "Create agent"}
    </Button>
  );
}

export function BirthAgentForm() {
  const [state, action] = useActionState<FormState, FormData>(
    birthAgentAction,
    undefined,
  );

  return (
    <form action={action} className="space-y-3">
      <div className="flex flex-col gap-3 sm:flex-row">
        <Input
          name="name"
          required
          minLength={2}
          maxLength={60}
          placeholder="Name your agent, e.g. Groceries Buyer"
          aria-label="Agent name"
        />
        <Submit />
      </div>
      {state?.error ? <ErrorNote>{state.error}</ErrorNote> : null}
    </form>
  );
}
