# Skyborn

**A human verifies once and funds once. After that their agent operates on its
own** — moving money, sending and reading messages, placing calls, pulling its
own one-time codes — over REST, MCP or AXL, with no further human involvement
short of revoking access.

> **Sandbox only.** No real money moves in this build, handles are unroutable,
> and identity checks are simulated. [What's real and what isn't](#whats-real-and-what-isnt)
> spells out exactly where the line sits.

---

## Contents

- [Quick start](#quick-start) · [Try the agent API](#try-the-agent-api)
- [How it works](#how-it-works) · [The two human moments](#the-two-human-moments)
- [What's real and what isn't](#whats-real-and-what-isnt)
- [Architecture](#architecture) · [One surface, three ways in](#one-surface-three-ways-in)
- [Design rules](#design-rules) — the invariants worth knowing before changing anything
- [Notes from integration](#notes-from-integration) — surprises worth recording
- [Operating it](#operating-it) · [Project layout](#project-layout) · [Scope and compliance](#scope-and-compliance)

---

## Quick start

Requires **Node 20+** and **PostgreSQL 14+**.

```bash
npm install
cp .env.example .env      # fill in DATABASE_URL, NEXTAUTH_SECRET, JWT_SECRET
npm run db:migrate
npm run db:seed
npm run dev               # → http://localhost:3000
```

Sign in as `ada@example.com` or `dev@example.com`, password `skyborn-sandbox`.

Want a populated dashboard — funded wallets, a real ledger, grants in every
state, an OTP sitting in an inbox?

```bash
npx tsx scripts/demo-data.ts    # prints its own login
```

### Try the agent API

Mint a working agent token without clicking through consent by hand:

```bash
npm run dev:grant
```

It prints an access token and a ready-to-paste curl:

```bash
curl -H 'Authorization: Bearer sky_at_…' http://localhost:3000/api/v1/wallet/balance
# {"walletId":"…","balancePaise":"500000","mode":"sandbox"}
```

It refuses to run with `NODE_ENV=production`, because it approves a grant
without a human — the one thing the consent flow exists to prevent.

### Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | Next dev server |
| `npm run build` | `prisma generate`, then a production build |
| `npm test` | The full suite — **224 tests**, needs a reachable `DATABASE_URL` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint |
| `npm run db:migrate` · `db:deploy` · `db:seed` · `db:studio` | Prisma |
| `npm run dev:grant` | Mint a sandbox agent token locally |

Most of the suite exercises real ledger, grant and webhook behaviour against
Postgres. Without a database the runner still reports 224 tests but only the
~54 pure-logic ones pass, which makes a partial run look like a much smaller
suite.

---

## How it works

An **agent** is born with a **handle**: one email address, one phone number, one
wallet. A **grant** is a scoped, revocable authorization an app holds over one
handle.

The agent has no identity of its own and never authenticates. It carries a
bearer token issued off a grant, and that grant exists only because a verified
human approved it once. Every call is checked against four things:

1. Is the token valid and unexpired?
2. Is its grant still active?
3. Does its scope cover this action?
4. For money — is it within the spending cap?

That is the entirety of "agent verification". It is a delegate acting under an
already-verified human, the same trust model as any OAuth app.

### The two human moments

| | | |
| --- | --- | --- |
| **1** | **Verify identity** | One check through a licensed KYC vendor. Skyborn keeps the verdict, the reference and a masked tail — never the number. |
| **2** | **Fund and approve** | Fund the wallet, set a spending cap, approve the grant. |

There is no third. No per-action approval, no OTP at call time, no browser
redirect — indefinitely, until the human revokes.

Because no individual action gets real-time approval, control lives at the
edges instead:

- **Upfront** — the spending cap, enforced server-side on every money-out call.
- **After the fact** — every action, successful *or refused*, lands in
  `GrantAuditLog` and shows up in the human's dashboard.
- **Always** — one-tap revoke kills the grant and every token issued off it, in
  a single transaction.

---

## What's real and what isn't

Every phase of the build plan is implemented. What varies is whether a **real
third party** is connected — and where one isn't, the code **refuses rather than
pretending**.

| Phase | | Status |
| --- | --- | --- |
| 1 | Accounts, agent birth, sandbox wallet | ✅ built |
| 2 | Wallet — mandate, top-up, transfer, refund, payout | ✅ built · simulated custody |
| 3 | Handle — email, SMS, voice, OTP retrieval | ✅ built · simulated providers |
| 4 | Auth API — DevApps, grants, consent, tokens | ✅ built |
| 5 | Core service layer | ✅ built |
| 6 | AXL runtime integration | ✅ built · verified against AXL 1.7.0 |
| 7 | MCP server | ✅ built · verified with the official SDK client |
| 8 | Dev dashboard, grants, audit log, webhooks, docs | ✅ built |
| 9 | Identity verification | ✅ built · simulated vendor |
| 10 | Live mode | 🔒 gate built · refuses, no custody partner |
| 11 | Virtual card issuance | ⛔ interface only — [and cannot be zero-touch](#why-virtual-cards-stay-an-interface) |

### The provider seam

Payments, messaging and KYC each sit behind an interface with two
implementations: a **simulated** driver used when no credentials are present,
and a **real** driver that throws until it is wired to a chosen partner.

**Nothing silently falls back.** A live wallet with no custody partner fails
hard, because a live wallet quietly running on fake money is strictly worse than
an error. The same holds for a KYC integration that would approve an identity
nobody checked — the most dangerous stub this codebase could contain.

Closing these is **Phase 0**: picking the KYC vendor and the money-custody/BaaS
partner. Neither choice changes an API shape. It is a business track, not a
coding task.

### Deliberately not real

- **Handles are unroutable.** Email uses a `.local` domain; phone numbers use
  country code `+99`, which E.164 does not assign. Neither can be mistaken for,
  or accidentally routed to, a real address. `Handle.provisioned` stays `false`
  and the UI says so wherever one is shown.
- **No money moves.** The simulated custody driver settles instantly and moves
  nothing.
- **KYC proves nothing.** The simulated vendor verifies instantly.
- **Live mode is closed.** It needs a verified human *and* a configured custody
  partner; either missing is a refusal.

---

## Architecture

```
                          src/server/core.ts
                     the only implementation of every action
                     scope check · spending cap · audit write
                    ╱             │              ╲
        /api/v1/*                 │               src/server/mcp.ts
     thin HTTP wrappers           │                  (in-process)
            ▲                     │                       ▲
            │                     │                       │
     direct callers      AXL engine :3939          MCP clients
                      (forwards to /api/v1)     (Claude, ChatGPT…)
```

### One surface, three ways in

This is worth stating plainly. There is **one implementation of every action**,
and it is `src/server/core.ts`. Nothing else holds wallet or messaging logic:

- `/api/v1/*` routes parse input and call core. Nothing more — a test fails if
  one ever touches the database directly.
- `axl/` contains **no handlers**, only `.flow` declarations. The engine reads
  `manifest.json` and forwards each call to the same `/api/v1` route a direct
  caller hits.
- The MCP adapter calls core in-process.

So `/actions/wallet_transfer` on the engine and `POST /api/v1/wallet/transfer`
run identical code. The first is the second with a gateway in front. A grant
approved through an MCP connector and one approved through curl are the same
row, and one revoke kills both.

**Four tests make drift impossible**: the `.flow` files must declare exactly the
catalogue's actions, point at exactly the endpoints REST serves, have a real
route file behind each, and no route may reach for the database.

**Which one should you expose?** Either — but pick one. `/api/v1` needs no extra
process and enforces scope, caps, rate limits and audit on its own. The AXL
engine adds edge schema validation, an `/mcp` endpoint and an event stream, at
the cost of a second service built from source. Running both publicly is two
doors to the same room.

---

## Design rules

The invariants worth knowing before changing anything.

**Money is integer paise, everywhere.** Every amount is a `BigInt` column of
minor units, and crosses the wire as a **string** — a large rupee figure loses
precision as a JSON double, and fractional paise do not exist. A JSON number is
rejected outright on every surface. `src/lib/money.ts` holds the only parse and
format functions.

**The ledger is append-only.** `LedgerEntry` rows are never updated or deleted.
A reversal is a new `refund_in`/`refund_out` row pointing back through
`originalEntryId`. Both legs of a transfer share a `transferGroupId` and are
reversed together or not at all. `Wallet.balance` is a cache written in the same
transaction as its entry, and `reconcileBalance()` rebuilds it from the entries.

**Debits are conditional, not checked.** Funds leave through an `UPDATE` guarded
by `balance >= amount`. A read-then-write check would let two concurrent debits
both pass a test that was true when each of them read it.

**Money-moving calls are idempotent.** A caller-supplied key is stored on the
entry under a unique constraint, so a retry — or a race between identical calls
— returns the original entry rather than moving money twice.

**Every action passes through one wrapper.** Scope check, server-side spending
cap, rate limit and audit write all live in a single helper in
`src/server/core.ts`. There is no code path that can skip them.

**Failures are audited too.** Nothing an agent does was approved in the moment,
so the dashboard is the only place a human learns what happened — and an app
repeatedly hitting its spending cap is exactly what someone would want to
notice.

**Rate limits hold on both surfaces.** AXL declares `RATE_LIMIT` per action, but
that only binds traffic through the engine — and `/api/v1` is directly
reachable. The same limits are enforced there, per grant and per action, from
the same definitions. A test parses `axl/flow/auth.flow` and fails if the two
disagree, or if any action is declared `PUBLIC`.

**Credentials are never stored in the clear.** Client secrets, API keys, access
and refresh tokens are shown once and kept as SHA-256 hashes. SHA-256 rather
than bcrypt is deliberate for machine credentials: they are 256-bit random
strings with no dictionary to slow down, and they are verified on every call.
Human passwords still use bcrypt.

**KYC identifiers cannot be stored.** The provider interface has nowhere to put
an Aadhaar number or SSN — the vendor collects it in its own hosted flow and
returns a verdict, a reference and a masked tail. A test asserts the `User`
table has no column one could be written to.

**Webhook destinations must be public.** Private, loopback and link-local ranges
are refused at registration *and* re-validated immediately before each delivery,
and the request is sent to the address that was validated — see
[the rebinding note](#a-validated-hostname-is-not-a-validated-connection).

---

## Notes from integration

Surprises worth recording for whoever reads this next.

### A refund is not inherently money-in

This was a live spending-cap bypass, and the reason is not obvious. A refund has
no fixed direction — it is the mirror of whatever it reverses. Reversing a debit
returns money (`refund_in`); reversing a **credit sends money out**
(`refund_out`).

Receiving is correctly uncapped — taking an inbound transfer is not spending.
But that made a loop: receive an inbound transfer far larger than the cap, then
refund it, and the reversal pushes the whole sum back out. The cap check never
fired, because a refund's parameters name only the entry being reversed, never
an amount. Repeat as needed.

The fix does **not** simply mark `wallet:refund` as money-out — that would
wrongly cap refunds bringing money *back*. Instead the outbound legs are
computed from the entry being reversed (the credit legs on this wallet), and
only that amount is capped, only when non-zero. It also counts toward cumulative
spend, or the bypass would just need more calls.

> **The general shape:** a cap keyed to a request parameter only holds for
> actions that name their amount up front. Anything whose value is implied by
> existing state has to resolve it before the check.

### A validated hostname is not a validated connection

Resolving a hostname, validating the address, then handing that *hostname* to an
HTTP client leaves a rebinding window: the client resolves it again
independently, so a short-TTL record can answer the check with a public address
and the connection with a private one moments later.

Delivery now dials the address that was validated. `fetch` cannot express this —
pinning would mean putting the IP in the URL, which breaks SNI and certificate
hostname verification. Node's `http`/`https` clients take a `lookup` hook that
overrides address resolution while leaving `host`, and therefore the TLS
servername and certificate check, as the original hostname.

### Three things about AXL differ from its own docs

Found by reading the repository, not by assuming:

- The CLI package is `scl-axl`, its binary is `axl`, and **it is not published to
  npm** — it must be built from source.
- **AXL does not generate routes into a project.** It is a gateway, and
  `DIAGRAM` is its only implemented generator. So the hand-written routes were
  never retired: they *are* what AXL forwards to, and deleting them would leave
  the engine forwarding into a 404.
- **AXL does not forward `Authorization` verbatim** as its docs state — the
  runtime re-shapes the bearer token into `Cookie: sid=<token>`. Skyborn accepts
  either carrier.

**No AXL action declares `CONFIRM`.** Its only confirmation gate holds a call
until a human supplies a one-time code — precisely the involvement this platform
exists to remove. The spending cap, audit log and revoke replace it.

### The MCP spec rewrite did not land as described

`@modelcontextprotocol/sdk` 1.30.0 has `LATEST_PROTOCOL_VERSION` `2025-11-25`
and **no `server/discover` method at all**. This is built against what actually
ships, and driven end to end by the SDK's own client.

### Why virtual cards stay an interface

Two reasons, and only the first is about time. Issuing needs a licensed partner
(Zeta, M2P, Karbon) with real onboarding lead time. But an arbitrary one-off card
purchase at a merchant with no prior mandate relationship also hits India's
card-not-present AFA requirement — so the human is asked for an OTP. **That is a
rule about card rails, not a gap in this code**, and no implementation removes
it. `wallet.transfer` stays the primary send-money primitive because it has none
of this problem.

---

## Operating it

Two things want a scheduler:

```bash
# Retries due webhook deliveries and sweeps expired rate-limit counters.
curl -X POST -H "Authorization: Bearer $WEBHOOK_WORKER_SECRET" \
  https://your-host/api/webhooks/run
```

Call it as often as you like — it only picks up work that is actually due. The
retry schedule lives in the database rather than a queue's memory, so a restart
cannot drop the backlog, and `runDueDeliveries()` can be driven by a BullMQ
worker instead if you prefer the spec's stack.

### Running the AXL surface

```bash
git clone https://github.com/Silvercloud-labs/axl && cd axl
npm install && npm run build          # scl-axl is not published to npm
cd /path/to/skyborn/axl
node /path/to/axl/packages/cli/dist/index.js build
node /path/to/axl/packages/cli/dist/index.js serve --port 3939
```

With Skyborn on :3000, the engine serves `/actions/:name`, `/resources/:name`,
`/mcp` and `/.well-known/axl` on :3939 and forwards to it.

---

## Project layout

```
prisma/schema.prisma       Full data model
src/lib/                   money · scopes · auth · api plumbing · action catalogue
src/server/                Core service layer + domain services
src/server/providers/      payments · messaging · kyc · cards — the seams
src/app/api/v1/            Agent-facing REST (the backend AXL fronts)
src/app/api/auth/          Grant request, consent, token, refresh
src/app/api/oauth/         OAuth 2.1 for MCP clients
src/app/api/mcp/           The MCP endpoint
src/app/api/webhooks/      Inbound provider hooks, registration, worker
axl/flow/                  .flow schemas compiled by scl-axl
tests/                     224 tests
```

The action catalogue in `src/lib/catalogue.ts` is defined **once** and feeds the
REST routes, `/.well-known/agent-tools.json`, the MCP tool list and the docs
page — so an action cannot be added to one surface and forgotten in another.

### Interface

Dark theme only, strictly monochrome: black grounds, grey surfaces and lines,
white and grey text. No light theme, no colour accent. Emphasis comes from
contrast and weight, and status is always carried by a word rather than a hue,
so every screen survives being read in greyscale. Tokens live in
`src/app/globals.css`; the primitives are in `src/components/ui.tsx`.

---

## Scope and compliance

Skyborn holds KYC and financial data, so this repository stays **private**.

The regulatory notes carried through this codebase — RBI's e-mandate framework,
the ₹15,000 no-OTP threshold, PPI custody through a licensed partner,
card-not-present AFA — are **factual grounding, not legal advice**. Get a real
compliance review before this touches a real user's money.
