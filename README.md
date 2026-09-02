# Skyborn

A human verifies their identity once and funds a wallet once. After that their
agent operates on its own — money, email, SMS, calls, one-time codes — over
REST, MCP or AXL, with no further human involvement short of revoking access.

**This repository is currently at Phase 1 of the build plan.** What that means
concretely is in [Status](#status) below. Nothing here moves real money.

---

## Running it

Requirements: Node 20+ and PostgreSQL 14+.

```bash
npm install
cp .env.example .env          # then fill in DATABASE_URL, NEXTAUTH_SECRET, JWT_SECRET
npm run db:migrate            # creates the schema
npm run db:seed               # sample users, agents and a DevApp
npm run dev                   # http://localhost:3000
```

Seeded logins — `ada@example.com` or `dev@example.com`, password
`skyborn-sandbox`.

Useful scripts:

| Script | What it does |
| --- | --- |
| `npm run dev` | Next dev server |
| `npm run build` | `prisma generate` then a production build |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint |
| `npm run db:migrate` | Create and apply a migration |
| `npm run db:deploy` | Apply existing migrations (deployments) |
| `npm run db:seed` | Idempotent sample data |
| `npm run db:studio` | Prisma Studio |

## Status

| Phase | | |
| --- | --- | --- |
| 1 | Skeleton — accounts, agent birth, sandbox wallet | **built** |
| 2 | Real wallet, sandbox money (Razorpay test mode, transfer/refund/payout) | not started |
| 3 | Real identity — Postmark and Twilio on the handle, OTP parser | not started |
| 4 | Auth API — DevApps, Grants, consent, tokens | not started |
| 5 | Core service layer | not started |
| 6 | AXL runtime integration | not started |
| 7 | MCP server | not started |
| 8 | Dev dashboard and grant management | not started |
| 9 | Real identity verification (KYC vendor) | not started |
| 10 | Live mode | not started |
| 11 | Virtual card issuance (stretch) | not started |

Phase 0 — picking the KYC vendor and the money-custody/BaaS partner — is a
business track that runs in parallel. Neither choice changes the shape of the
Wallet API, but nothing can go live without both.

### What Phase 1 actually gives you

- Email/password accounts for the human side (Mode A).
- **Agent birth**: naming an agent atomically allocates its `Handle` (one email
  address, one phone number) and opens its sandbox `Wallet`. An agent without a
  handle or a wallet cannot exist in the database.
- A sandbox wallet with a **manually creditable** balance, backed by an
  append-only ledger.
- A dashboard listing agents, their handles, their balances and their ledger.

### What Phase 1 deliberately does *not* do

- **Handles are internal placeholders.** Emails use a `.local` domain and phone
  numbers use country code `+99`, which E.164 does not assign — so neither can
  be mistaken for, or accidentally routed to, a real address. `Handle.provisioned`
  stays `false` and the UI says so on every screen that shows one. Phase 3
  replaces both with real Postmark/Twilio values.
- **No real money.** No Razorpay, no funding mandate, no custody partner. The
  only ledger entry type Phase 1 writes is `manual_credit`, and
  `creditWalletManually()` refuses to touch a wallet that is not in sandbox mode.
- **No agent-facing API.** `Grant`, `AccessToken` and `GrantAuditLog` exist as
  tables but nothing issues a token yet, so there is no way for an agent to act
  on a handle. That is Phase 4.
- **No KYC.** Every user is `unverified`. Live mode is refused at agent birth.

## Design notes

**Money is integer paise, everywhere.** Every amount is a `BigInt` column
holding minor units. No float ever holds a rupee amount. `src/lib/money.ts` has
the only parse and format functions; use them rather than hand-rolling.

**The ledger is append-only.** `LedgerEntry` rows are never updated or deleted.
A reversal is a new `refund_in`/`refund_out` row pointing back through
`originalEntryId`; both legs of an internal transfer share a `transferGroupId`.
`Wallet.balance` is only a cache written in the same transaction as its entry —
`reconcileBalance()` can always rebuild it from the entries alone.

**`mode` is present from day one.** Every `Handle`, `Wallet` and `Grant` carries
`sandbox | live` (spec Section 14) rather than having it bolted on later.

**KYC identifiers are never stored raw.** The `User` table holds the vendor's
verdict, the vendor's reference, and a masked tail for display. The full Aadhaar
number or SSN never reaches this database — that constraint is in the schema
now, before there is any vendor to break it.

**Ownership is checked server-side, always.** Every query that loads an agent
goes through `getAgentForUser(userId, agentId)`. An id arriving in a URL or a
form field is not an authorization.

### Layout

```
prisma/schema.prisma     Full Section 7 data model, including later-phase tables
prisma/seed.ts           Idempotent sample data
src/lib/auth.ts          NextAuth (Mode A, humans only)
src/lib/money.ts         Paise parsing and formatting
src/lib/prisma.ts        Prisma client singleton
src/server/agents.ts     Agent birth, ownership-scoped reads
src/server/wallet.ts     Sandbox credit, ledger reads, balance reconciliation
src/server/handles.ts    Phase 1 placeholder email/phone allocation
src/server/actions.ts    Server actions — the only write path from the UI
src/components/          Monochrome UI primitives
src/app/                 Landing, auth, dashboard
```

`src/server/*` holds plain, transport-agnostic functions on purpose. Phase 5
turns this into the single core service layer that the REST, MCP and AXL
adapters all call — the point being that the wallet and messaging logic exists
exactly once, no matter how many surfaces reach it.

### Interface

Dark theme only, and strictly monochrome: black grounds, grey surfaces and
lines, white and grey text. There is no light theme and no colour accent —
emphasis comes from contrast and weight, and status is always carried by a word
rather than by hue, so every screen survives being read in greyscale. The
tokens live in `src/app/globals.css`; the primitives that consume them are in
`src/components/ui.tsx`.

## Notes on scope

Skyborn holds KYC and financial data, so this repository stays **private**.

The regulatory notes carried through this codebase — RBI's e-mandate framework,
the ₹15,000 no-OTP threshold, PPI custody through a licensed partner — are
factual grounding, not legal advice. Get a real compliance review before this
touches a real user's money.
