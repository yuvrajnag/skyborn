import type { Metadata } from "next";
import Link from "next/link";

import { Badge, Card, CardHeader, Mono } from "@/components/ui";
import { ACTIONS } from "@/lib/catalogue";
import { SCOPES, SCOPE_DESCRIPTIONS } from "@/lib/scopes";
import { getCurrentUser } from "@/lib/auth";

export const metadata: Metadata = { title: "Docs" };

/**
 * The developer docs, generated from the same ACTIONS array that produces the
 * REST routes, the discovery catalogue, the MCP tool list and the AXL schemas.
 * Docs that are written separately from the surface they describe go stale the
 * first time somebody adds an action; these cannot.
 */
export default async function DocsPage() {
  const user = await getCurrentUser();

  return (
    <div className="flex min-h-full flex-1 flex-col">
      <header className="border-line border-b">
        <div className="mx-auto flex w-full max-w-4xl items-center justify-between px-6 py-5">
          <Link href="/" className="text-text text-sm font-semibold tracking-tight">
            Skyborn
          </Link>
          <Link
            href={user ? "/dashboard" : "/signin"}
            className="text-text-dim hover:text-text text-sm transition-colors"
          >
            {user ? "Dashboard" : "Sign in"}
          </Link>
        </div>
      </header>

      <main className="mx-auto w-full max-w-4xl flex-1 px-6 py-12">
        <h1 className="text-text text-3xl font-semibold tracking-tight">
          Skyborn for Devs
        </h1>
        <p className="text-text-dim mt-4 max-w-2xl text-sm leading-relaxed">
          One action surface, reachable three ways. Every action below exists
          once in the core service layer; REST, MCP and AXL are adapters over
          it, so a grant approved through any of them behaves identically and is
          revoked by the same button.
        </p>

        <section className="mt-12">
          <h2 className="text-text text-xl font-medium tracking-tight">
            Getting a token
          </h2>
          <p className="text-text-dim mt-3 max-w-2xl text-sm leading-relaxed">
            The human appears exactly once. After they approve, everything is
            machine-to-machine — no browser, no OTP, indefinitely, until they
            revoke.
          </p>

          <ol className="mt-6 space-y-4">
            {[
              ["Register an app", "Create one in the dashboard and keep the client id and secret."],
              ["Request a grant", "POST /api/auth/grants with the agent id, scopes and a spending cap. You get back a grant_id and a consent_url."],
              ["The human approves, once", "They open the consent URL and approve. This is the only human step in the entire flow."],
              ["Exchange for a token", "POST /api/auth/token with the grant id and your client credentials."],
              ["Call anything", "Authorization: Bearer <token>, refreshed via /api/auth/token/refresh when it expires."],
            ].map(([title, body], index) => (
              <li key={title} className="border-line bg-surface flex gap-4 rounded-xl border p-5">
                <Mono className="text-text-faint shrink-0">
                  {String(index + 1).padStart(2, "0")}
                </Mono>
                <div>
                  <p className="text-text text-sm font-medium">{title}</p>
                  <p className="text-text-dim mt-1 text-sm leading-relaxed">{body}</p>
                </div>
              </li>
            ))}
          </ol>

          <Card className="mt-6">
            <CardHeader title="Discovery" description="Machine-readable, always current." />
            <div className="divide-line divide-y">
              {[
                ["/.well-known/agent-tools.json", "Every callable action, with JSON Schema."],
                ["/.well-known/oauth-protected-resource", "Where an MCP client starts."],
                ["/.well-known/oauth-authorization-server", "OAuth 2.1 metadata. S256 PKCE only."],
                ["/api/mcp", "The MCP endpoint itself."],
              ].map(([path, note]) => (
                <div key={path} className="px-5 py-3.5">
                  <Mono className="text-text">{path}</Mono>
                  <p className="text-text-dim mt-1 text-sm">{note}</p>
                </div>
              ))}
            </div>
          </Card>
        </section>

        <section className="mt-14">
          <h2 className="text-text text-xl font-medium tracking-tight">Scopes</h2>
          <Card className="mt-5">
            <ul className="divide-line divide-y">
              {SCOPES.map((scope) => (
                <li key={scope} className="flex flex-wrap items-baseline gap-x-4 gap-y-1 px-5 py-3.5">
                  <Mono className="text-text w-44 shrink-0">{scope}</Mono>
                  <span className="text-text-dim text-sm">{SCOPE_DESCRIPTIONS[scope]}</span>
                </li>
              ))}
            </ul>
          </Card>
        </section>

        <section className="mt-14">
          <h2 className="text-text text-xl font-medium tracking-tight">Actions</h2>
          <p className="text-text-dim mt-3 max-w-2xl text-sm leading-relaxed">
            Amounts are integer paise carried as strings — ₹1 is{" "}
            <Mono className="text-text">&quot;100&quot;</Mono>. A rupee figure large enough
            to matter loses precision as a JSON number, and fractional paise do
            not exist, so a float is rejected outright.
          </p>

          <div className="mt-6 space-y-4">
            {ACTIONS.map((action) => (
              <Card key={action.name}>
                <div className="border-line flex flex-wrap items-center justify-between gap-3 border-b px-5 py-4">
                  <div className="flex flex-wrap items-center gap-3">
                    <Mono className="text-text font-medium">{action.name}</Mono>
                    <Badge tone="outline">{action.scope}</Badge>
                    {action.irreversible ? <Badge tone="solid">irreversible</Badge> : null}
                  </div>
                  <Mono className="text-text-dim">
                    {action.method} {action.path}
                  </Mono>
                </div>

                <div className="px-5 py-4">
                  <p className="text-text-dim text-sm leading-relaxed">{action.description}</p>
                  {action.effects ? (
                    <p className="text-text mt-3 text-sm leading-relaxed">
                      <span className="text-text-faint text-xs tracking-wide uppercase">
                        Effects
                      </span>
                      <br />
                      {action.effects}
                    </p>
                  ) : null}

                  {action.parameters.length > 0 ? (
                    <dl className="mt-4 space-y-2">
                      {action.parameters.map((parameter) => (
                        <div key={parameter.name} className="flex flex-wrap gap-x-3 gap-y-1">
                          <dt className="shrink-0">
                            <Mono className="text-text">{parameter.name}</Mono>
                            <span className="text-text-faint ml-2 text-xs">
                              {parameter.type}
                              {parameter.required ? " · required" : ""}
                            </span>
                          </dt>
                          <dd className="text-text-dim min-w-0 flex-1 text-sm">
                            {parameter.description}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  ) : (
                    <p className="text-text-faint mt-4 text-sm">No parameters.</p>
                  )}

                  <p className="text-text-faint mt-4 text-xs">
                    MCP tool name: <Mono>{action.toolName}</Mono>
                  </p>
                </div>
              </Card>
            ))}
          </div>
        </section>

        <section className="mt-14">
          <h2 className="text-text text-xl font-medium tracking-tight">
            Retrying safely
          </h2>
          <p className="text-text-dim mt-3 max-w-2xl text-sm leading-relaxed">
            Send an <Mono className="text-text">Idempotency-Key</Mono> header on any call that
            moves money. A repeat with the same key returns the original entry
            and{" "}
            <Mono className="text-text">replayed: true</Mono> rather than moving money a second
            time. Without one, a retry is a second real movement.
          </p>
        </section>
      </main>

      <footer className="border-line border-t">
        <div className="text-text-faint mx-auto w-full max-w-4xl px-6 py-6 text-xs">
          Sandbox preview. No real money moves in this build.
        </div>
      </footer>
    </div>
  );
}
