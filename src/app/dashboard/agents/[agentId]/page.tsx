import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { Badge, Card, CardHeader, EmptyState, Mono } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { formatRupees } from "@/lib/money";
import { getAgentForUser } from "@/server/agents";
import { listTransactions } from "@/server/wallet";
import { CreditForm } from "./credit-form";

export const metadata: Metadata = { title: "Agent" };

const ENTRY_LABELS: Record<string, string> = {
  manual_credit: "Manual sandbox credit",
  topup: "Top-up",
  withdrawal: "Withdrawal",
  transfer_in: "Transfer in",
  transfer_out: "Transfer out",
  refund_in: "Refund in",
  refund_out: "Refund out",
  virtual_card_charge: "Virtual card charge",
};

function DetailRow({
  label,
  value,
  note,
}: {
  label: string;
  value: React.ReactNode;
  note?: string;
}) {
  return (
    <div className="border-line flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 border-b px-5 py-4 last:border-b-0">
      <span className="text-text-dim text-xs font-medium tracking-wide uppercase">
        {label}
      </span>
      <div className="text-right">
        <div className="text-text text-sm">{value}</div>
        {note ? <p className="text-text-faint mt-1 text-xs">{note}</p> : null}
      </div>
    </div>
  );
}

export default async function AgentPage({
  params,
}: {
  params: Promise<{ agentId: string }>;
}) {
  const user = await requireUser();
  const { agentId } = await params;

  const agent = await getAgentForUser(user.id, agentId);
  if (!agent || !agent.handle || !agent.wallet) notFound();

  const entries = await listTransactions(agent.wallet.id);

  return (
    <div className="space-y-8">
      <div>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-text text-2xl font-semibold tracking-tight">
            {agent.name}
          </h1>
          <Badge>{agent.wallet.mode}</Badge>
        </div>
        <Mono className="text-text-dim mt-2 block">{agent.id}</Mono>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader
            title="Handle"
            description="One email address, one phone number — allocated at birth."
          />
          <div>
            <DetailRow
              label="Email"
              value={<Mono>{agent.handle.email}</Mono>}
              note={
                agent.handle.provisioned
                  ? undefined
                  : "Internal placeholder — cannot send or receive mail yet."
              }
            />
            <DetailRow
              label="Phone"
              value={<Mono>{agent.handle.phone}</Mono>}
              note={
                agent.handle.provisioned
                  ? undefined
                  : "Internal placeholder — not a dialable number yet."
              }
            />
            <DetailRow label="Mode" value={agent.handle.mode} />
            <DetailRow
              label="Born"
              value={agent.createdAt.toISOString().slice(0, 10)}
            />
          </div>
        </Card>

        <Card>
          <CardHeader
            title="Wallet"
            description="Sandbox balance, credited by hand until the funding mandate lands."
          />
          <div className="border-line border-b px-5 py-6">
            <p className="text-text-dim text-xs font-medium tracking-wide uppercase">
              Balance
            </p>
            <p className="text-text mt-2 font-mono text-3xl tracking-tight">
              {formatRupees(agent.wallet.balance)}
            </p>
          </div>
          <div className="p-5">
            <CreditForm agentId={agent.id} />
          </div>
        </Card>
      </div>

      <Card>
        <CardHeader
          title="Ledger"
          description="Append-only. Entries are never edited or deleted — a reversal is its own entry."
          action={
            <span className="text-text-faint text-xs">
              {entries.length} {entries.length === 1 ? "entry" : "entries"}
            </span>
          }
        />
        {entries.length === 0 ? (
          <EmptyState
            title="Nothing on the ledger yet"
            description="Credit the wallet above and the entry shows up here immediately."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[36rem] text-left text-sm">
              <thead>
                <tr className="text-text-faint border-line border-b text-xs tracking-wide uppercase">
                  <th className="px-5 py-3 font-medium">When</th>
                  <th className="px-5 py-3 font-medium">Type</th>
                  <th className="px-5 py-3 font-medium">Note</th>
                  <th className="px-5 py-3 text-right font-medium">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-line divide-y">
                {entries.map((entry) => {
                  const isCredit = entry.direction === "credit";
                  return (
                    <tr key={entry.id} className="hover:bg-surface-hi transition-colors">
                      <td className="text-text-dim px-5 py-3 whitespace-nowrap">
                        <Mono>
                          {entry.createdAt.toISOString().slice(0, 16).replace("T", " ")}
                        </Mono>
                      </td>
                      <td className="text-text px-5 py-3">
                        {ENTRY_LABELS[entry.type] ?? entry.type}
                      </td>
                      <td className="text-text-dim max-w-[16rem] truncate px-5 py-3">
                        {entry.description ?? "—"}
                      </td>
                      <td className="px-5 py-3 text-right whitespace-nowrap">
                        <Mono className={isCredit ? "text-text" : "text-text-dim"}>
                          {isCredit ? "+" : "−"}
                          {formatRupees(entry.amount)}
                        </Mono>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
