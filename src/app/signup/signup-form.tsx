"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import { Button, ErrorNote, Field, Input } from "@/components/ui";
import { signupAction, type FormState } from "@/server/actions";

function Submit() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending} className="w-full">
      {pending ? "Creating account…" : "Create account"}
    </Button>
  );
}

export function SignupForm() {
  const [state, action] = useActionState<FormState, FormData>(
    signupAction,
    undefined,
  );

  return (
    <form action={action} className="space-y-5">
      {state?.error ? <ErrorNote>{state.error}</ErrorNote> : null}

      <Field label="Name">
        <Input name="name" autoComplete="name" required placeholder="Ada Lovelace" />
      </Field>

      <Field label="Email">
        <Input
          name="email"
          type="email"
          autoComplete="email"
          required
          placeholder="you@example.com"
        />
      </Field>

      <Field label="Password" hint="At least 10 characters.">
        <Input
          name="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={10}
        />
      </Field>

      <Submit />
    </form>
  );
}
