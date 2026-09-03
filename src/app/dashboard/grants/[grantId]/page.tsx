import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Badge, Card, CardHeader, EmptyState, Mono } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { formatRupees } from "@/lib/money";
import { SCOPE_DESCRIPTIONS, type Scope } from "@/lib/scopes";
import { grantActivity, spentUnderGrant } from "@/server/core";
import { getGrantForUser } from "@/server/grants";
import { RevokeButton } from "../revoke-button";

export const metadata: Metadata = { title: "Grant" };

/**
 * The audit log (spec Section 15).
 *
 * Nothing on this page was approved in the moment — that is the whole design.
 * So this is the only place a human ever finds out what their agent actually
 * did, and refusals are shown alongside successes: an app repeatedly hitting
 * its spending cap is exactly the signal someone would want to notice.
 */
export default async function GrantDetailPage({
  params,
}: {
  params: Promise<{ grantId: string }>;
}) {
  const user = await requireUser();
  const { grantId } = await params;

  const grant = await getGrantForUser({ grantId, userId: user.id });
  if (!grant) notFound();

  const [logs, spent] = await Promise.all([
    grantActivity(grant.id, 200),
    spentUnderGrant(grant.id),
  ]);

  const refusals = logs.filter((log) => log.resultStatus !== "ok").length;

  return (
    <div className="space-y-8">
      <div>
        <Link
          href="/dashboard/grants"
          className="text-text-dim hover:text-text text-sm transition-colors"
        >
          ← Grants
        </Link>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <h1 className="text-text text-2xl font-semibold tracking-tight">
            {grant.devApp.name}
          </h1>
          <Badge tone={grant.status === "active" ? "solid" : "outline"}>{grant.status}</Badge>
          <Badge>via {grant.issuedVia}</Badge>
        </div>
        <p className="text-text-dim mt-2 text-sm">acting as {grant.agent.name}</p>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Scopes" description="Exactly what this app was approved to do." />
          <ul className="divide-line divide-y">
            {(grant.scopes as Scope[]).map((scope) => (
              <li key={scope} className="px-5 py-3.5">
                <Mono className="text-text">{scope}</Mono>
                <p className="text-text-dim mt-1 text-sm">{SCOPE_DESCRIPTIONS[scope]}</p>
              </li>
            ))}
          </ul>
        </Card>

        <Card>
          <CardHeader title="Spending" description="Enforced server-side on every money-out call." />
          <div className="border-line border-b px-5 py-6">
            <p className="text-text-dim text-xs font-medium tracking-wide uppercase">Spent</p>
            <p className="text-text mt-2 font-mono text-3xl tracking-tight">
              {formatRupees(spent)}
            </p>
            <p className="text-text-faint mt-2 text-sm">
              {grant.spendingCap === null
                ? "No cap — this app can spend the whole wallet balance."
                : `of ${formatRupees(grant.spendingCap)} approved`}
            </p>
          </div>
          <div className="space-y-4 p-5">
            <div className="flex justify-between text-sm">
              <span className="text-text-dim">Recorded actions</span>
              <Mono className="text-text">{logs.length}</Mono>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-text-dim">Refused</span>
              <Mono className="text-text">{refusals}</Mono>
            </div>
            {grant.status !== "revoked" ? <RevokeButton grantId={grant.id} /> : null}
          </div>
        </Card>
      </div>

      <Card>
        <CardHeader
          title="Activity"
          description="Every action taken under this grant, successful or refused. None of it was approved in the moment."
          action={<span className="text-text-faint text-xs">{logs.length} recorded</span>}
        />
        {logs.length === 0 ? (
          <EmptyState
            title="Nothing recorded yet"
            description="Once this app starts acting, every call it makes appears here."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[42rem] text-left text-sm">
              <thead>
                <tr className="text-text-faint border-line border-b text-xs tracking-wide uppercase">
                  <th className="px-5 py-3 font-medium">When</th>
                  <th className="px-5 py-3 font-medium">Action</th>
                  <th className="px-5 py-3 font-medium">Parameters</th>
                  <th className="px-5 py-3 font-medium">Result</th>
                </tr>
              </thead>
              <tbody className="divide-line divide-y">
                {logs.map((log) => (
                  <tr key={log.id} className="hover:bg-surface-hi transition-colors">
                    <td className="text-text-dim px-5 py-3 whitespace-nowrap">
                      <Mono>
                        {log.createdAt.toISOString().slice(0, 16).replace("T", " ")}
                      </Mono>
                    </td>
                    <td className="text-text px-5 py-3 whitespace-nowrap">
                      <Mono>{log.action}</Mono>
                    </td>
                    <td className="text-text-dim max-w-[20rem] truncate px-5 py-3">
                      <Mono className="text-text-faint">
                        {summarize(log.paramsSummary)}
                      </Mono>
                    </td>
                    <td className="px-5 py-3 whitespace-nowrap">
                      {log.resultStatus === "ok" ? (
                        <span className="text-text-dim text-sm">ok</span>
                      ) : (
                        // Carried by a word, never by colour alone.
                        <span className="text-text text-sm font-medium">
                          refused · {log.errorCode}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

/** Renders the stored parameter summary compactly, amounts as rupees. */
function summarize(params: unknown): string {
  if (!params || typeof params !== "object") return "—";
  const entries = Object.entries(params as Record<string, unknown>).filter(
    ([, value]) => value !== undefined && value !== null && value !== "",
  );
  if (entries.length === 0) return "—";

  return entries
    .map(([key, value]) => {
      if (key === "amountPaise" && typeof value === "string") {
        return `amount=${formatRupees(BigInt(value))}`;
      }
      return `${key}=${String(value)}`;
    })
    .join("  ");
}
