import { redirect } from "next/navigation";

import { ButtonLink, Card, Mono } from "@/components/ui";
import { getCurrentUser } from "@/lib/auth";

const HUMAN_MOMENTS = [
  {
    step: "01",
    title: "Verify identity",
    body: "One identity check through a licensed KYC vendor. Skyborn stores the vendor's verdict and reference — never a raw Aadhaar number or SSN.",
  },
  {
    step: "02",
    title: "Fund and approve",
    body: "Fund the wallet, set a spending cap, approve the grant. That is the last time a human is asked for anything.",
  },
];

const SURFACES = [
  {
    name: "REST",
    body: "Plain HTTP against the action surface. One bearer token, refreshed on its own.",
  },
  {
    name: "MCP",
    body: "Connect Skyborn once in an MCP-native client. Every session after that uses the stored token silently.",
  },
  {
    name: "AXL",
    body: "Schema-compiled actions for AXL-native agents, routed into the same core service layer.",
  },
];

const PHASES = [
  { label: "Accounts, agent birth, sandbox wallet", state: "built" },
  { label: "Wallet — mandate, top-up, transfer, refund, payout", state: "simulated" },
  { label: "Handle — email, SMS, voice, one-time codes", state: "simulated" },
  { label: "Auth API — grants, consent, tokens, revoke", state: "built" },
  { label: "Core service layer, REST surface", state: "built" },
  { label: "AXL runtime, MCP server, dev dashboard", state: "built" },
  { label: "Identity verification", state: "simulated" },
  { label: "Live mode", state: "gated" },
  { label: "Virtual card issuance", state: "not viable yet" },
];

export default async function LandingPage() {
  const user = await getCurrentUser();
  if (user) redirect("/dashboard");

  return (
    <div className="flex min-h-full flex-col">
      <header className="border-line border-b">
        <div className="mx-auto flex w-full max-w-5xl items-center justify-between px-6 py-5">
          <span className="text-text text-sm font-semibold tracking-tight">
            Skyborn
          </span>
          <nav className="flex items-center gap-2">
            <ButtonLink href="/signin" variant="ghost">
              Sign in
            </ButtonLink>
            <ButtonLink href="/signup">Create account</ButtonLink>
          </nav>
        </div>
      </header>

      <main className="mx-auto w-full max-w-5xl flex-1 px-6">
        <section className="border-line border-b py-20">
          <p className="text-text-faint text-xs font-medium tracking-[0.2em] uppercase">
            Sandbox preview
          </p>
          <h1 className="text-text mt-5 max-w-3xl text-4xl leading-[1.1] font-semibold tracking-tight text-balance sm:text-5xl">
            Verify once. Fund once. Then your agent is on its own.
          </h1>
          <p className="text-text-dim mt-6 max-w-2xl text-lg leading-relaxed">
            Every agent is born with a handle — one email address, one phone
            number, one wallet. After a single approval it moves money, sends
            and reads messages, places calls and pulls its own one-time codes,
            machine to machine, with no human in the loop.
          </p>
          <div className="mt-9 flex flex-wrap items-center gap-3">
            <ButtonLink href="/signup">Create an account</ButtonLink>
            <ButtonLink href="/signin" variant="secondary">
              Sign in
            </ButtonLink>
          </div>
        </section>

        <section className="border-line grid gap-px border-b sm:grid-cols-2">
          {HUMAN_MOMENTS.map((moment) => (
            <div key={moment.step} className="py-12 sm:px-6 sm:first:pl-0">
              <Mono className="text-text-faint">{moment.step}</Mono>
              <h2 className="text-text mt-3 text-xl font-medium tracking-tight">
                {moment.title}
              </h2>
              <p className="text-text-dim mt-3 text-sm leading-relaxed">
                {moment.body}
              </p>
            </div>
          ))}
        </section>

        <section className="border-line border-b py-16">
          <h2 className="text-text text-xl font-medium tracking-tight">
            One action surface, reached three ways
          </h2>
          <p className="text-text-dim mt-3 max-w-2xl text-sm leading-relaxed">
            The wallet and messaging logic exists once. Each surface is an
            adapter over it, so a grant approved through one is indistinguishable
            from a grant approved through another — and just as revocable.
          </p>
          <div className="mt-8 grid gap-4 sm:grid-cols-3">
            {SURFACES.map((surface) => (
              <Card key={surface.name} className="p-5">
                <Mono className="text-text">{surface.name}</Mono>
                <p className="text-text-dim mt-3 text-sm leading-relaxed">
                  {surface.body}
                </p>
              </Card>
            ))}
          </div>
        </section>

        <section className="py-16">
          <h2 className="text-text text-xl font-medium tracking-tight">
            What is actually built
          </h2>
          <p className="text-text-dim mt-3 max-w-2xl text-sm leading-relaxed">
            Every phase is implemented. What varies is whether a real third
            party is connected — and where one is not, the code refuses rather
            than pretending. Nothing here moves real money.
          </p>
          <ol className="border-line mt-8 divide-y divide-[var(--color-line)] overflow-hidden rounded-xl border">
            {PHASES.map((phase, index) => (
              <li
                key={phase.label}
                className="bg-surface flex items-center justify-between gap-4 px-5 py-3.5"
              >
                <div className="flex min-w-0 items-center gap-4">
                  <Mono className="text-text-faint">
                    {String(index + 1).padStart(2, "0")}
                  </Mono>
                  <span
                    className={
                      phase.state === "built"
                        ? "text-text text-sm"
                        : "text-text-dim text-sm"
                    }
                  >
                    {phase.label}
                  </span>
                </div>
                <span className="text-text-faint shrink-0 text-xs tracking-wide uppercase">
                  {phase.state}
                </span>
              </li>
            ))}
          </ol>
        </section>
      </main>

      <footer className="border-line border-t">
        <div className="text-text-faint mx-auto w-full max-w-5xl px-6 py-6 text-xs">
          Skyborn — sandbox preview. No real money moves in this build.
        </div>
      </footer>
    </div>
  );
}
