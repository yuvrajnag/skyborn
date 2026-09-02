import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { Badge, Card, CardHeader, Mono } from "@/components/ui";
import { getCurrentUser } from "@/lib/auth";
import { formatRupees } from "@/lib/money";
import { prisma } from "@/lib/prisma";
import { SCOPE_DESCRIPTIONS, type Scope } from "@/lib/scopes";
import { ConsentForm } from "./consent-form";

export const metadata: Metadata = { title: "Approve access" };

/**
 * The one human moment in the entire flow (spec Section 10, step 3).
 *
 * Everything the human is agreeing to has to be legible here, because they will
 * not be asked again: no per-action approval, no OTP, no prompt at call time.
 * The only thing standing between this click and an autonomous agent is the
 * revoke button on the dashboard.
 */
export default async function ConsentPage({
  params,
  searchParams,
}: {
  params: Promise<{ grantId: string }>;
  searchParams: Promise<{ approved?: string; denied?: string }>;
}) {
  const { grantId } = await params;
  const { approved, denied } = await searchParams;

  const user = await getCurrentUser();
  if (!user) redirect(`/signin?next=${encodeURIComponent(`/consent/${grantId}`)}`);

  const grant = await prisma.grant.findUnique({
    where: { id: grantId },
    include: { agent: { include: { handle: true, wallet: true } }, devApp: true },
  });
  if (!grant) notFound();

  // Only the human who owns the handle may see or answer this request.
  if (grant.agent.userId !== user.id) notFound();

  const decided = grant.status !== "pending";

  return (
    <div className="flex min-h-full flex-1 flex-col">
      <header className="border-line border-b">
        <div className="mx-auto w-full max-w-2xl px-6 py-5">
          <Link href="/dashboard" className="text-text text-sm font-semibold tracking-tight">
            Skyborn
          </Link>
        </div>
      </header>

      <main className="mx-auto w-full max-w-2xl flex-1 px-6 py-12">
        <p className="text-text-faint text-xs font-medium tracking-[0.2em] uppercase">
          Authorization request
        </p>
        <h1 className="text-text mt-4 text-2xl font-semibold tracking-tight text-balance">
          {grant.devApp.name} wants to act as {grant.agent.name}
        </h1>
        <p className="text-text-dim mt-4 text-sm leading-relaxed">
          This is the only time you will be asked. Once approved, this app acts
          on its own — no further prompts, no one-time codes, no confirmation per
          action. You can revoke it at any moment from your dashboard, and every
          action it takes is recorded there.
        </p>

        {approved === "1" ? (
          <div className="border-line-hi bg-surface-hi text-text mt-8 rounded-lg border px-4 py-3 text-sm">
            Approved. {grant.devApp.name} can now act as {grant.agent.name}.
          </div>
        ) : null}
        {denied === "1" ? (
          <div className="border-line-hi bg-surface-hi text-text mt-8 rounded-lg border px-4 py-3 text-sm">
            Denied. Nothing was authorized.
          </div>
        ) : null}

        <Card className="mt-8">
          <CardHeader
            title="What it will be able to do"
            action={<Badge tone={grant.status === "active" ? "solid" : "outline"}>{grant.status}</Badge>}
          />
          <ul className="divide-line divide-y">
            {(grant.scopes as Scope[]).map((scope) => (
              <li key={scope} className="px-5 py-3.5">
                <Mono className="text-text">{scope}</Mono>
                <p className="text-text-dim mt-1 text-sm">{SCOPE_DESCRIPTIONS[scope]}</p>
              </li>
            ))}
          </ul>
        </Card>

        <Card className="mt-6">
          <CardHeader title="Limits" />
          <div>
            <div className="border-line flex items-baseline justify-between gap-4 border-b px-5 py-4">
              <span className="text-text-dim text-xs font-medium tracking-wide uppercase">
                Spending cap
              </span>
              <span className="text-text text-right text-sm">
                {grant.spendingCap === null ? (
                  <>
                    No cap
                    <span className="text-text-faint mt-1 block text-xs">
                      This app can spend the whole wallet balance.
                    </span>
                  </>
                ) : (
                  <>
                    {formatRupees(grant.spendingCap)}
                    <span className="text-text-faint mt-1 block text-xs">
                      Enforced on every payment, not just in this screen.
                    </span>
                  </>
                )}
              </span>
            </div>
            <div className="border-line flex items-baseline justify-between gap-4 border-b px-5 py-4">
              <span className="text-text-dim text-xs font-medium tracking-wide uppercase">
                Mode
              </span>
              <span className="text-text text-sm">{grant.mode}</span>
            </div>
            <div className="border-line flex items-baseline justify-between gap-4 border-b px-5 py-4">
              <span className="text-text-dim text-xs font-medium tracking-wide uppercase">
                Handle
              </span>
              <Mono className="text-text">{grant.agent.handle?.email ?? "—"}</Mono>
            </div>
            <div className="flex items-baseline justify-between gap-4 px-5 py-4">
              <span className="text-text-dim text-xs font-medium tracking-wide uppercase">
                Requested via
              </span>
              <span className="text-text text-sm">{grant.issuedVia}</span>
            </div>
          </div>
        </Card>

        <div className="mt-8">
          {decided ? (
            <p className="text-text-dim text-sm">
              This request has already been {grant.status === "active" ? "approved" : "revoked"}.{" "}
              <Link href="/dashboard/grants" className="text-text underline underline-offset-4">
                Manage it from your dashboard
              </Link>
              .
            </p>
          ) : (
            <ConsentForm grantId={grant.id} />
          )}
        </div>
      </main>
    </div>
  );
}
