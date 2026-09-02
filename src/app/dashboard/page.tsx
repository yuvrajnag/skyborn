import type { Metadata } from "next";
import Link from "next/link";

import { Badge, Card, CardHeader, EmptyState, Mono } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { formatRupees } from "@/lib/money";
import { listAgentsForUser } from "@/server/agents";
import { BirthAgentForm } from "./birth-agent-form";

export const metadata: Metadata = { title: "Agents" };

export default async function DashboardPage() {
  const user = await requireUser();
  const agents = await listAgentsForUser(user.id);

  const total = agents.reduce(
    (sum, agent) => sum + (agent.wallet?.balance ?? 0n),
    0n,
  );

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-text text-2xl font-semibold tracking-tight">
            Agents
          </h1>
          <p className="text-text-dim mt-2 text-sm">
            {agents.length === 0
              ? "Every agent is born with a handle: one email address, one phone number, one wallet."
              : `${agents.length} agent${agents.length === 1 ? "" : "s"} · ${formatRupees(total)} held across all sandbox wallets.`}
          </p>
        </div>
      </div>

      <Card>
        <CardHeader
          title="Give birth to an agent"
          description="Creating an agent allocates its handle and opens its sandbox wallet in one step."
        />
        <div className="p-5">
          <BirthAgentForm />
        </div>
      </Card>

      <Card>
        <CardHeader title="Your agents" />
        {agents.length === 0 ? (
          <EmptyState
            title="No agents yet"
            description="Name your first agent above. It gets a handle and an empty sandbox wallet immediately."
          />
        ) : (
          <ul className="divide-line divide-y">
            {agents.map((agent) => (
              <li key={agent.id}>
                <Link
                  href={`/dashboard/agents/${agent.id}`}
                  className="hover:bg-surface-hi flex items-center justify-between gap-4 px-5 py-4 transition-colors"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-text truncate text-sm font-medium">
                        {agent.name}
                      </span>
                      <Badge>{agent.wallet?.mode ?? "sandbox"}</Badge>
                    </div>
                    <Mono className="text-text-dim mt-1 block truncate">
                      {agent.handle?.email ?? "—"}
                    </Mono>
                  </div>
                  <div className="shrink-0 text-right">
                    <Mono className="text-text">
                      {formatRupees(agent.wallet?.balance ?? 0n)}
                    </Mono>
                    <p className="text-text-faint mt-1 text-xs">balance</p>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
