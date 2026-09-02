import Link from "next/link";
import type { ReactNode } from "react";

export function AuthShell({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
  footer: ReactNode;
}) {
  return (
    <div className="flex min-h-full flex-1 flex-col">
      <header className="border-line border-b">
        <div className="mx-auto w-full max-w-5xl px-6 py-5">
          <Link href="/" className="text-text text-sm font-semibold tracking-tight">
            Skyborn
          </Link>
        </div>
      </header>
      <main className="flex flex-1 items-center justify-center px-6 py-16">
        <div className="w-full max-w-sm">
          <h1 className="text-text text-2xl font-semibold tracking-tight">
            {title}
          </h1>
          <p className="text-text-dim mt-2 text-sm leading-relaxed">{subtitle}</p>
          <div className="mt-8">{children}</div>
          <div className="text-text-dim mt-6 text-sm">{footer}</div>
        </div>
      </main>
    </div>
  );
}
