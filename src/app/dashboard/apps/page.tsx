import type { Metadata } from "next";

import { Badge, Card, CardHeader, EmptyState, Mono } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { CreateAppForm } from "./create-app-form";

export const metadata: Metadata = { title: "Apps" };

export default async function AppsPage() {
  const user = await requireUser();

  const apps = await prisma.devApp.findMany({
    where: { userId: user.id },
    include: { _count: { select: { grants: true } } },
    orderBy: { createdAt: "desc" },
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
                </p>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
