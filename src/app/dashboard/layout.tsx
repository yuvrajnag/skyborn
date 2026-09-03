import Link from "next/link";
import { redirect } from "next/navigation";

import { SignOutButton } from "@/components/sign-out-button";
import { Badge } from "@/components/ui";
import { getCurrentUser } from "@/lib/auth";

const NAV = [
  { href: "/dashboard", label: "Agents" },
  { href: "/dashboard/grants", label: "Grants" },
  { href: "/dashboard/apps", label: "Apps" },
  { href: "/dashboard/verify", label: "Identity" },
  { href: "/docs", label: "Docs" },
];

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
          <div className="flex min-w-0 items-center gap-5">
            <Link
              href="/dashboard"
              className="text-text text-sm font-semibold tracking-tight"
            >
              Skyborn
            </Link>
            <Badge tone="outline">Sandbox</Badge>
            <nav className="hidden items-center gap-4 sm:flex">
              {NAV.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="text-text-dim hover:text-text text-sm transition-colors"
                >
                  {item.label}
                </Link>
              ))}
            </nav>
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
          Sandbox only. Handles are internal placeholders, custody is simulated,
          and no real money moves.
        </div>
      </footer>
    </div>
  );
}
