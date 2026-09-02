import Link from "next/link";
import { redirect } from "next/navigation";

import { SignOutButton } from "@/components/sign-out-button";
import { Badge } from "@/components/ui";
import { getCurrentUser } from "@/lib/auth";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");

  return (
    <div className="flex min-h-full flex-1 flex-col">
      <header className="border-line bg-ink sticky top-0 z-10 border-b">
        <div className="mx-auto flex w-full max-w-5xl items-center justify-between gap-4 px-6 py-4">
          <div className="flex min-w-0 items-center gap-3">
            <Link
              href="/dashboard"
              className="text-text text-sm font-semibold tracking-tight"
            >
              Skyborn
            </Link>
            <Badge tone="outline">Sandbox</Badge>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-text-dim hidden truncate text-sm sm:block">
              {user.email}
            </span>
            <SignOutButton />
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-10">{children}</main>

      <footer className="border-line border-t">
        <div className="text-text-faint mx-auto w-full max-w-5xl px-6 py-6 text-xs">
          Phase 1 · sandbox only. Handles are internal placeholders and no real
          money moves.
        </div>
      </footer>
    </div>
  );
}
