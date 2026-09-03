# Skyborn

A human verifies their identity once and funds a wallet once. After that their
agent operates on its own — money, email, SMS, calls, one-time codes — over
REST, MCP or AXL, with no further human involvement short of revoking access.

**Sandbox only. No real money moves in this build.** What is and is not real is
spelled out in [Status](#status).

---

## Running it

Requirements: Node 20+ and PostgreSQL 14+.

```bash
npm install
cp .env.example .env          # fill in DATABASE_URL, NEXTAUTH_SECRET, JWT_SECRET
npm run db:migrate
npm run db:seed
npm run dev                   # http://localhost:3000
```

Seeded logins — `ada@example.com` or `dev@example.com`, password
`skyborn-sandbox`.

To exercise the agent-facing surface without clicking through consent by hand:

```bash
npm run dev:grant             # prints a working access token and a curl to try
```

| Script | What it does |
| --- | --- |
| `npm run dev` | Next dev server |
| `npm run build` | `prisma generate` then a production build |
| `npm test` | The full suite (224 tests — needs `DATABASE_URL`) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint |
| `npm run db:migrate` / `db:deploy` / `db:seed` / `db:studio` | Prisma |
| `npm run dev:grant` | Mint a sandbox agent token locally |

Most of the suite exercises real ledger, grant and webhook behaviour against
Postgres, so `npm test` needs a reachable `DATABASE_URL`. Without one the runner
still reports 224 tests but only the ~54 pure-logic ones (money formatting, OTP
parsing, signatures, address classification) pass.

## Status

Every phase in the build plan is implemented. What differs between them is
whether a **real third party** is connected — and where one is not, the code
refuses rather than pretending.

| Phase | | |
| --- | --- | --- |
| 1 | Skeleton — accounts, agent birth, sandbox wallet | built |
| 2 | Wallet — mandate, top-up, transfer, refund, payout | built, simulated custody |
| 3 | Handle — email, SMS, voice, OTP retrieval | built, simulated providers |
| 4 | Auth API — DevApps, grants, consent, tokens | built |
| 5 | Core service layer | built |
| 6 | AXL runtime integration | built, verified against AXL 1.7.0 |
| 7 | MCP server | built, verified with the official SDK client |
| 8 | Dev dashboard, grants, audit log, webhooks, docs | built |
| 9 | Identity verification | built, simulated vendor |
| 10 | Live mode | gate built, refuses — no custody partner |
| 11 | Virtual card issuance | interface only, and cannot be zero-touch |

### The provider seam

Payments, messaging and KYC each sit behind an interface with two
implementations: a **simulated** driver used when no credentials are present,
and a **real** driver that throws until it is wired to a chosen partner.

Nothing silently falls back. A live-mode wallet with no custody partner
configured fails hard, because a live wallet quietly running on fake money is
strictly worse than an error. The same applies to a KYC integration that would
approve an identity nobody checked — the most dangerous stub this codebase
could contain, so it refuses instead.

Phase 0 — picking the KYC vendor and the money-custody/BaaS partner — is the
business track that closes these. Neither choice changes an API shape.

### What is deliberately not real

- **Handles are unroutable.** Email uses a `.local` domain, phone numbers use
  country code `+99`, which E.164 does not assign. `Handle.provisioned` stays
  `false` and the UI says so wherever one is shown.
- **No money moves.** The simulated custody driver settles instantly and moves
  nothing.
- **KYC proves nothing.** The simulated vendor verifies instantly.
- **Live mode is closed.** It needs a verified human *and* a configured custody
  partner; either missing is a refusal.
- **Virtual cards are an interface and a documented refusal** — see below.

## Design notes

**Money is integer paise, everywhere.** Every amount is a `BigInt` column of
minor units, and crosses the wire as a *string*: a large rupee figure loses
precision as a JSON double, and fractional paise do not exist. A float amount
is rejected outright. `src/lib/money.ts` holds the only parse and format
functions.

**The ledger is append-only.** `LedgerEntry` rows are never updated or deleted.
A reversal is a new `refund_in`/`refund_out` row pointing back through
`originalEntryId`; both legs of a transfer share a `transferGroupId` and are
reversed together or not at all. `Wallet.balance` is a cache written in the same
transaction as its entry, and `reconcileBalance()` rebuilds it from the entries
alone.

**Debits are conditional, not checked.** Funds leave through an `UPDATE`
guarded by `balance >= amount`. A read-then-write check would let two concurrent
debits both pass a test that was true when each of them read it.

**Money-moving calls are idempotent.** A caller-supplied key is stored on the
entry under a unique constraint, so a retry — or a race between identical calls
— returns the original entry instead of moving money twice.

**One implementation of every action.** `src/server/core.ts` is the only place
an action exists. Scope check, server-side spending-cap check and audit write
wrap every call through a single helper, so no code path can skip them. REST,
MCP and AXL are thin callers.

**Failures are audited too.** Nothing an agent does was approved in the moment,
so the dashboard is the only place a human learns what happened — and an app
repeatedly hitting its spending cap is exactly what someone would want to
notice.

**Rate limits hold on both surfaces.** AXL declares `RATE_LIMIT` per action, but
those limits only apply to traffic that goes through the AXL engine — and
`/api/v1` is reachable directly. The same limits are enforced there, per grant
and per action, from the same definition. A test parses `axl/flow/auth.flow` and
fails if the two ever disagree, or if any action is declared `PUBLIC`.

**Webhook destinations must be public.** Anyone who can register a webhook could
otherwise make Skyborn issue POSTs from inside the network — at cloud metadata,
at the database, at any internal endpoint — and read the outcome through the
recorded response code. Private, loopback and link-local ranges are refused at
registration *and* again immediately before each delivery, because a name that
resolved publicly when registered can be re-pointed afterwards.

**Credentials are never stored in the clear.** Client secrets, API keys, access
and refresh tokens are shown once and kept as SHA-256 hashes. SHA-256 rather
than bcrypt is deliberate for machine credentials: they are 256-bit random
strings with no dictionary to slow down, and they are verified on every call.
Human passwords still use bcrypt.

**KYC identifiers cannot be stored.** The provider interface has nowhere to put
an Aadhaar number or SSN — the vendor collects it in their own hosted flow and
returns a verdict, a reference and a masked tail. A test asserts the `User`
table has no column one could be written to.

### REST and AXL are one surface

This is worth stating plainly, because the wording in Section 12 implies
otherwise. There is **one implementation of every action**, and it is
`src/server/core.ts`. Nothing else contains wallet or messaging logic:

```
                    src/server/core.ts          <- the only implementation
                     |          |         |
        /api/v1/* ---+          |         +--- src/server/mcp.ts  (in-process)
        (thin HTTP wrappers)    |
                                |
        AXL engine :3939 -------+  (forwards over HTTP to /api/v1/*)
```

`axl/` contains no handlers — only `.flow` declarations. The AXL engine reads
`manifest.json`, validates shapes, applies rate limits, and forwards each call
to the same `/api/v1` route a direct caller would hit. So `/actions/wallet_transfer`
on :3939 and `POST /api/v1/wallet/transfer` on :3000 run identical code; the
first is the second with a gateway in front.

Section 12 says the AXL-generated routes should replace the hand-written ones.
AXL 1.7.0 does not generate routes into a project — it is a gateway, and its
only implemented generator is `DIAGRAM`. So there was nothing to retire: the
Phase 5 routes *are* what AXL forwards to, and deleting them would leave the
engine forwarding into a 404. The spec's actual goal — never implementing the
logic twice — holds.

Four tests enforce it, so the two cannot drift: the `.flow` files must declare
exactly the catalogue's actions, must point at exactly the endpoints the REST
surface serves, must have a real route file behind each, and no route may touch
the database directly.

**Which one should you expose?** Either, but pick one. `/api/v1` needs no extra
process and enforces scope, spending caps, rate limits and audit on its own.
The AXL engine adds schema validation at the edge, a `/mcp` endpoint and an
event stream, at the cost of running a second service built from source. Both
run the same rules; running both publicly just means two doors to the same room.

### A refund is not inherently money-in

Worth recording, because it was a live spending-cap bypass and the reason is not
obvious. A refund has no fixed direction — it is the mirror of whatever it
reverses. Reversing a debit returns money (`refund_in`); reversing a **credit
sends money out** (`refund_out`).

Receiving is correctly uncapped: a grant taking an inbound transfer is not
spending. But that made a loop: receive an inbound transfer far larger than the
cap, then refund it, and the reversal pushes the whole sum straight back out —
and the cap check never fired, because a refund's parameters name only the entry
being reversed, never an amount. Repeat as needed.

The fix does not simply mark `wallet:refund` as money-out, because that would
wrongly cap refunds that bring money *back*. Instead the outbound legs are
computed from the entry being reversed — the credit legs belonging to this
wallet — and only that amount is capped, and only when it is non-zero. It also
counts toward cumulative spend, or the bypass would just need more calls.

The general shape: **a cap keyed to a request parameter only holds for actions
that name their amount up front.** Anything whose value is implied by existing
state has to resolve it before the check.

### Notes from integration

Three things about AXL differ from the build spec's description, found by
reading the repository rather than assuming:

- The CLI package is `scl-axl`, its binary is `axl`, and it is not on npm — it
  must be built from source.
- AXL does not generate routes into this repo. It is a gateway that reads
  `manifest.json` and forwards to `BASE_URL`, so the Phase 5 routes are not
  retired by Phase 6; they *become* the backend AXL calls.
- AXL does not forward `Authorization` verbatim as its docs state — the runtime
  re-shapes the bearer token into `Cookie: sid=<token>`. Skyborn accepts either
  carrier.

No AXL action declares `CONFIRM`. Its only confirmation gate holds a call until
a human supplies a one-time code, which is precisely the involvement this
platform exists to remove. The spending cap, audit log and revoke replace it.

On MCP: `@modelcontextprotocol/sdk` 1.30.0 has `LATEST_PROTOCOL_VERSION`
`2025-11-25` and no `server/discover` method, so the breaking rewrite the build
spec warns about did not land as described. This is built against what ships,
and driven end to end by the SDK's own client.

### Why virtual cards stay an interface

Two reasons, and only the first is about time. Issuing needs a licensed partner
(Zeta, M2P, Karbon) with real onboarding lead time. But a genuinely arbitrary
one-off card purchase at a merchant with no prior mandate relationship also hits
India's card-not-present AFA requirement — so the human is asked for an OTP.
That is a rule about card rails, not a gap in this code, and no implementation
removes it. `wallet.transfer` stays the primary send-money primitive because it
has none of this problem.

### Layout

```
prisma/schema.prisma       Full Section 7 data model
src/lib/                   money, scopes, auth, api plumbing, action catalogue
src/server/                Core service layer + domain services
src/server/providers/      payments, messaging, kyc, cards — the seams
src/app/api/v1/            Agent-facing REST (the backend AXL fronts)
src/app/api/auth/          Grant request, consent, token, refresh
src/app/api/oauth/         OAuth 2.1 for MCP clients
src/app/api/mcp/           The MCP endpoint
src/app/api/webhooks/      Inbound provider hooks, endpoint registration, worker
axl/flow/                  .flow schemas compiled by scl-axl
tests/                     224 tests
```

The action catalogue in `src/lib/catalogue.ts` is defined once and feeds the
REST routes, `/.well-known/agent-tools.json`, the MCP tool list and the docs
page, so an action cannot be added to one surface and forgotten in another.

### Interface

Dark theme only, strictly monochrome: black grounds, grey surfaces and lines,
white and grey text. No light theme, no colour accent. Emphasis comes from
contrast and weight, and status is always carried by a word rather than a hue,
so every screen survives being read in greyscale. Tokens live in
`src/app/globals.css`; the primitives are in `src/components/ui.tsx`.

## Running the AXL surface

```bash
git clone https://github.com/Silvercloud-labs/axl && cd axl
npm install && npm run build          # scl-axl is not published to npm
cd /path/to/skyborn/axl
node /path/to/axl/packages/cli/dist/index.js build
node /path/to/axl/packages/cli/dist/index.js serve --port 3939
```

With Skyborn running on :3000, the engine serves `/actions/:name`,
`/resources/:name`, `/mcp` and `/.well-known/axl` on :3939 and forwards to it.

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

## Scope

Skyborn holds KYC and financial data, so this repository stays **private**.

The regulatory notes carried through this codebase — RBI's e-mandate framework,
the ₹15,000 no-OTP threshold, PPI custody through a licensed partner, card-not-
present AFA — are factual grounding, not legal advice. Get a real compliance
review before this touches a real user's money.
