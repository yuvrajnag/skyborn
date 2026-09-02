"use client";

import { signIn } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { Button, ErrorNote, Field, Input } from "@/components/ui";

export function SigninForm({ defaultEmail }: { defaultEmail?: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);

    const data = new FormData(event.currentTarget);
    const result = await signIn("credentials", {
      email: String(data.get("email") ?? ""),
      password: String(data.get("password") ?? ""),
      redirect: false,
    });

    if (result?.ok) {
      router.push("/dashboard");
      router.refresh();
      return;
    }

    setPending(false);
    setError("That email and password combination did not match an account.");
  }

  return (
    <form onSubmit={onSubmit} className="space-y-5">
      {error ? <ErrorNote>{error}</ErrorNote> : null}

      <Field label="Email">
        <Input
          name="email"
          type="email"
          autoComplete="email"
          required
          defaultValue={defaultEmail}
          placeholder="you@example.com"
        />
      </Field>

      <Field label="Password">
        <Input name="password" type="password" autoComplete="current-password" required />
      </Field>

      <Button type="submit" disabled={pending} className="w-full">
        {pending ? "Signing in…" : "Sign in"}
      </Button>
    </form>
  );
}
