import type { Metadata } from "next";
import Link from "next/link";

import { Badge, Card, CardHeader, EmptyState, Mono } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { formatRupees } from "@/lib/money";
import { listGrantsForUser } from "@/server/grants";
import { RevokeButton } from "./revoke-button";

export const metadata: Metadata = { title: "Grants" };

/**
 * Where a human sees what they have authorized and takes it back.
 *
 * A grant approved through an MCP connector and one approved through plain REST
 * look identical here, because they are the same row — only `issuedVia` records
 * which surface asked. That is the promise in spec Section 8 made visible.
 */
export default async function GrantsPage() {
  const user = await requireUser();
  const grants = await listGrantsForUser(user.id);

  const active = grants.filter((g) => g.status === "active");

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-text text-2xl font-semibold tracking-tight">Grants</h1>
        <p className="text-text-dim mt-2 text-sm leading-relaxed">
          {grants.length === 0
            ? "Nothing has been authorized to act as your agents yet."
            : `${active.length} active of ${grants.length}. Revoking a grant kills every token issued from it immediately, whichever surface it was approved through.`}
        </p>
      </div>

      <Card>
        <CardHeader title="Authorized apps" />
        {grants.length === 0 ? (
          <EmptyState
            title="No grants yet"
            description="When an app asks to act as one of your agents, the request appears here for you to approve or deny."
          />
        ) : (
          <ul className="divide-line divide-y">
            {grants.map((grant) => (
              <li key={grant.id} className="flex flex-wrap items-start justify-between gap-4 px-5 py-4">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link
                      href={`/dashboard/grants/${grant.id}`}
                      className="text-text text-sm font-medium underline-offset-4 hover:underline"
                    >
                      {grant.devApp.name}
                    </Link>
                    <Badge tone={grant.status === "active" ? "solid" : "outline"}>
                      {grant.status}
                    </Badge>
                    <Badge>via {grant.issuedVia}</Badge>
                  </div>

                  <p className="text-text-dim mt-1 text-sm">
                    acting as {grant.agent.name} ·{" "}
                    {grant.spendingCap === null
                      ? "no spending cap"
                      : `capped at ${formatRupees(grant.spendingCap)}`}
                  </p>

                  <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
                    {grant.scopes.map((scope) => (
                      <Mono key={scope} className="text-text-faint">
                        {scope}
                      </Mono>
                    ))}
                  </div>

                  <p className="text-text-faint mt-2 text-xs">
                    {grant._count.auditLogs} recorded action
                    {grant._count.auditLogs === 1 ? "" : "s"}
                  </p>
                </div>

                {grant.status !== "revoked" ? <RevokeButton grantId={grant.id} /> : null}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
