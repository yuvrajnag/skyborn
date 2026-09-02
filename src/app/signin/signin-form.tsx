"use client";

import { signIn } from "next-auth/react";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";

import { Button, ErrorNote, Field, Input } from "@/components/ui";

export function SigninForm({ defaultEmail }: { defaultEmail?: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  /**
   * Sign-in runs entirely in the submit handler, so the form must not be
   * submittable before React has attached it. A native submit would send the
   * password as a GET query string — into the address bar, browser history and
   * every access log in front of this app.
   *
   * Two things stop that: method="post" means even a fallback submit keeps the
   * password out of the URL, and the button stays disabled until this effect
   * confirms the handler is live.
   */
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);

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
      // Honour ?next= so a consent or authorize link resumes where it left off,
      // but only for a path on this site — an absolute URL here would be an
      // open redirect straight out of the login form.
      const next = searchParams.get("next");
      const target = next && next.startsWith("/") && !next.startsWith("//") ? next : "/dashboard";
      router.push(target);
      router.refresh();
      return;
    }

    setPending(false);
    setError("That email and password combination did not match an account.");
  }

  return (
    <form method="post" onSubmit={onSubmit} className="space-y-5">
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

      <Button type="submit" disabled={pending || !ready} className="w-full">
        {pending ? "Signing in…" : "Sign in"}
      </Button>
    </form>
  );
}
