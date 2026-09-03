import type { Metadata } from "next";

import { Badge, Card, CardHeader, EmptyState, Mono } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { MAX_ATTEMPTS } from "@/server/webhooks";
import { CreateAppForm } from "./create-app-form";

export const metadata: Metadata = { title: "Apps" };

export default async function AppsPage() {
  const user = await requireUser();

  const apps = await prisma.devApp.findMany({
    where: { userId: user.id },
    include: {
      _count: { select: { grants: true } },
      webhookEndpoints: { orderBy: { createdAt: "desc" } },
    },
    orderBy: { createdAt: "desc" },
  });

  const deliveries = await prisma.webhookDelivery.findMany({
    where: { endpoint: { devApp: { userId: user.id } } },
    include: { endpoint: true },
    orderBy: { createdAt: "desc" },
    take: 40,
  });

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-text text-2xl font-semibold tracking-tight">Apps</h1>
        <p className="text-text-dim mt-2 text-sm leading-relaxed">
          An app requests grants over handles. Sandbox keys are issued at
          creation; live keys unlock with identity verification.
        </p>
      </div>

      <Card>
        <CardHeader
          title="Register an app"
          description="Secrets are shown once and stored only as hashes."
        />
        <div className="p-5">
          <CreateAppForm />
        </div>
      </Card>

      <Card>
        <CardHeader title="Your apps" />
        {apps.length === 0 ? (
          <EmptyState
            title="No apps yet"
            description="Register one above to get a client id and sandbox keys."
          />
        ) : (
          <ul className="divide-line divide-y">
            {apps.map((app) => (
              <li key={app.id} className="px-5 py-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-text text-sm font-medium">{app.name}</span>
                  {app.isPublicClient ? <Badge>public client</Badge> : null}
                  {app.liveKeyId ? <Badge>live</Badge> : <Badge tone="outline">sandbox only</Badge>}
                </div>
                <Mono className="text-text-dim mt-1 block break-all">{app.clientId}</Mono>
                <p className="text-text-faint mt-2 text-xs">
                  {app._count.grants} grant{app._count.grants === 1 ? "" : "s"}
                  {app.redirectUris.length > 0
                    ? ` · ${app.redirectUris.length} redirect URI${app.redirectUris.length === 1 ? "" : "s"}`
                    : ""}
                  {app.webhookEndpoints.length > 0
                    ? ` · ${app.webhookEndpoints.length} webhook endpoint${app.webhookEndpoints.length === 1 ? "" : "s"}`
                    : ""}
                </p>

                {app.webhookEndpoints.length > 0 ? (
                  <ul className="mt-3 space-y-1">
                    {app.webhookEndpoints.map((endpoint) => (
                      <li key={endpoint.id} className="flex flex-wrap items-baseline gap-x-3">
                        <Mono className="text-text-dim break-all">{endpoint.url}</Mono>
                        <span className="text-text-faint text-xs">
                          {endpoint.events.join(", ")}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <CardHeader
          title="Webhook deliveries"
          description={`Retried with exponential backoff, up to ${MAX_ATTEMPTS} attempts. Every request is HMAC-signed over a timestamp, so a capture cannot be replayed.`}
          action={<span className="text-text-faint text-xs">{deliveries.length} recent</span>}
        />
        {deliveries.length === 0 ? (
          <EmptyState
            title="No deliveries yet"
            description="Register an endpoint against an app and events will start appearing here as your agents act."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[40rem] text-left text-sm">
              <thead>
                <tr className="text-text-faint border-line border-b text-xs tracking-wide uppercase">
                  <th className="px-5 py-3 font-medium">When</th>
                  <th className="px-5 py-3 font-medium">Event</th>
                  <th className="px-5 py-3 font-medium">Endpoint</th>
                  <th className="px-5 py-3 font-medium">Attempts</th>
                  <th className="px-5 py-3 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-line divide-y">
                {deliveries.map((delivery) => (
                  <tr key={delivery.id} className="hover:bg-surface-hi transition-colors">
                    <td className="text-text-dim px-5 py-3 whitespace-nowrap">
                      <Mono>
                        {delivery.createdAt.toISOString().slice(0, 16).replace("T", " ")}
                      </Mono>
                    </td>
                    <td className="text-text px-5 py-3 whitespace-nowrap">
                      <Mono>{delivery.event}</Mono>
                    </td>
                    <td className="text-text-dim max-w-[14rem] truncate px-5 py-3">
                      <Mono className="text-text-faint">{delivery.endpoint.url}</Mono>
                    </td>
                    <td className="text-text-dim px-5 py-3 whitespace-nowrap">
                      <Mono>
                        {delivery.attempts}/{MAX_ATTEMPTS}
                      </Mono>
                    </td>
                    <td className="px-5 py-3 whitespace-nowrap">
                      {/* Carried by a word plus the response code, never colour. */}
                      <span
                        className={
                          delivery.status === "delivered"
                            ? "text-text-dim text-sm"
                            : "text-text text-sm font-medium"
                        }
                      >
                        {delivery.status}
                        {delivery.responseCode ? ` · ${delivery.responseCode}` : ""}
                      </span>
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
