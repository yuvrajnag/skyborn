import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { Card, CardHeader, Mono } from "@/components/ui";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { SCOPE_DESCRIPTIONS, isScope, type Scope } from "@/lib/scopes";
import { AuthorizeForm } from "./authorize-form";

export const metadata: Metadata = { title: "Authorize" };

/**
 * The OAuth authorization screen — step 2/3 of Section 13.
 *
 * This is the same decision as the REST consent page, reached from an MCP
 * client instead: pick a handle, set a spending cap, approve once. From here
 * the client stores a token and every future chat session uses it silently.
 */
export default async function AuthorizePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const params = await searchParams;
  const here = `/oauth/authorize?${new URLSearchParams(
    Object.entries(params).filter(([, v]) => v !== undefined) as [string, string][],
  )}`;

  const user = await getCurrentUser();
  if (!user) redirect(`/signin?next=${encodeURIComponent(here)}`);

  function fail(reason: string) {
    return (
      <Shell>
        <h1 className="text-text text-2xl font-semibold tracking-tight">
          This request cannot be completed
        </h1>
        <p className="text-text-dim mt-4 text-sm leading-relaxed">{reason}</p>
        <p className="text-text-faint mt-6 text-xs">
          Nothing was authorized. You can close this window.
        </p>
      </Shell>
    );
  }

  const clientId = params.client_id;
  const redirectUri = params.redirect_uri;
  const codeChallenge = params.code_challenge;

  if (!clientId || !redirectUri || !codeChallenge) {
    return fail("The request is missing client_id, redirect_uri or code_challenge.");
  }
  if (params.response_type && params.response_type !== "code") {
    return fail(`Only response_type=code is supported, not "${params.response_type}".`);
  }
  if (params.code_challenge_method && params.code_challenge_method !== "S256") {
    return fail("Only S256 PKCE is accepted. Plain PKCE gives a public client no protection.");
  }

  const devApp = await prisma.devApp.findUnique({ where: { clientId } });
  if (!devApp) return fail("That client_id is not registered with Skyborn.");

  // Exact match. Prefix matching on redirect URIs is how authorization codes
  // end up delivered to somebody else's server.
  if (!devApp.redirectUris.includes(redirectUri)) {
    return fail("The redirect_uri does not exactly match one registered for this client.");
  }

  const requested = (params.scope ?? "wallet:read")
    .split(/[\s,+]+/)
    .filter(Boolean);
  const unknown = requested.filter((scope) => !isScope(scope));
  if (unknown.length > 0) return fail(`Unknown scope(s): ${unknown.join(", ")}.`);

  const agents = await prisma.agent.findMany({
    where: { userId: user.id },
    include: { handle: true },
    orderBy: { createdAt: "desc" },
  });

  if (agents.length === 0) {
    return fail(
      "You have no agents yet. Create one in your dashboard first, then retry this request.",
    );
  }

  return (
    <Shell>
      <p className="text-text-faint text-xs font-medium tracking-[0.2em] uppercase">
        Authorization request
      </p>
      <h1 className="text-text mt-4 text-2xl font-semibold tracking-tight text-balance">
        {devApp.name} wants to act as one of your agents
      </h1>
      <p className="text-text-dim mt-4 text-sm leading-relaxed">
        This is the only time you will be asked. After you approve, this client
        stores a token and uses it silently in every future session — no
        prompts, no one-time codes — until you revoke it from your dashboard.
      </p>

      <Card className="mt-8">
        <CardHeader title="What it will be able to do" />
        <ul className="divide-line divide-y">
          {(requested as Scope[]).map((scope) => (
            <li key={scope} className="px-5 py-3.5">
              <Mono className="text-text">{scope}</Mono>
              <p className="text-text-dim mt-1 text-sm">{SCOPE_DESCRIPTIONS[scope]}</p>
            </li>
          ))}
        </ul>
      </Card>

      <Card className="mt-6">
        <CardHeader title="Where the code goes" />
        <div className="px-5 py-4">
          <Mono className="text-text-dim break-all">{redirectUri}</Mono>
        </div>
      </Card>

      <div className="mt-8">
        <AuthorizeForm
          agents={agents.map((agent) => ({
            id: agent.id,
            name: agent.name,
            handle: agent.handle?.email ?? "—",
          }))}
          hidden={{
            clientId,
            redirectUri,
            codeChallenge,
            state: params.state ?? "",
            scopes: requested.join(" "),
          }}
          defaultCapPaise="200000"
        />
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-full flex-1 flex-col">
      <header className="border-line border-b">
        <div className="mx-auto w-full max-w-2xl px-6 py-5">
          <Link href="/dashboard" className="text-text text-sm font-semibold tracking-tight">
            Skyborn
          </Link>
        </div>
      </header>
      <main className="mx-auto w-full max-w-2xl flex-1 px-6 py-12">{children}</main>
    </div>
  );
}
