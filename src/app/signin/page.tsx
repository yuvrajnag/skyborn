import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { AuthShell } from "@/components/auth-shell";
import { getCurrentUser } from "@/lib/auth";
import { SigninForm } from "./signin-form";

export const metadata: Metadata = { title: "Sign in" };

export default async function SigninPage({
  searchParams,
}: {
  searchParams: Promise<{ registered?: string; email?: string }>;
}) {
  if (await getCurrentUser()) redirect("/dashboard");

  const params = await searchParams;
  const justRegistered = params.registered === "1";

  return (
    <AuthShell
      title="Sign in"
      subtitle={
        justRegistered
          ? "Your account is ready. Sign in to give your first agent a handle."
          : "Sign in to manage your agents, their handles and their wallets."
      }
      footer={
        <>
          No account yet?{" "}
          <Link href="/signup" className="text-text underline underline-offset-4">
            Create one
          </Link>
        </>
      }
    >
      <SigninForm defaultEmail={params.email} />
    </AuthShell>
  );
}
