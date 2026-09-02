import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { AuthShell } from "@/components/auth-shell";
import { getCurrentUser } from "@/lib/auth";
import { SignupForm } from "./signup-form";

export const metadata: Metadata = { title: "Create account" };

export default async function SignupPage() {
  if (await getCurrentUser()) redirect("/dashboard");

  return (
    <AuthShell
      title="Create your account"
      subtitle="This is the human side of Skyborn. Identity verification arrives with live mode — for now every account is sandbox only."
      footer={
        <>
          Already have an account?{" "}
          <Link href="/signin" className="text-text underline underline-offset-4">
            Sign in
          </Link>
        </>
      }
    >
      <SignupForm />
    </AuthShell>
  );
}
