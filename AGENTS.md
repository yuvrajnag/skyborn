# Working in this repository

Skyborn — a two-sided platform where a human verifies once and funds once, and
their agent operates autonomously after that. See `README.md` for what runs and
which build phase this is at.

## Stack

Next.js 15 (App Router) · TypeScript · PostgreSQL via Prisma 6 · NextAuth v4 ·
Tailwind CSS v4.

Note the versions: this repo is pinned to **Next 15**, not 16. `create-next-app`
scaffolds 16 by default, so do not let a dependency bump drift the major
without a deliberate decision.

## Rules that are not negotiable

- **Money is integer paise in `BigInt` columns.** Never a float, never a
  `number`. Parse and format only through `src/lib/money.ts`.
- **The ledger is append-only.** Never `UPDATE` or `DELETE` a `LedgerEntry`. A
  reversal is a new `refund_in`/`refund_out` row referencing `originalEntryId`.
  `Wallet.balance` is a cache written in the same transaction as its entry.
- **Never store a raw Aadhaar number or SSN.** Only the KYC vendor's verdict,
  its reference, and a masked tail for display.
- **Ownership is checked server-side on every read and write.** Go through
  `getAgentForUser(userId, agentId)`. An id in a URL or a form field is not an
  authorization.
- **`mode` (`sandbox | live`) is carried by every Handle, Wallet and Grant.**
  Anything that moves money must branch on it, not assume sandbox.
- **Scope and spending-cap checks live in the service layer, never in the UI.**

## Layout

`src/server/*` holds plain, transport-agnostic functions. Phase 5 turns these
into the single core service layer that the REST, MCP and AXL adapters all call.
Keep business logic there — not in route handlers, server actions or components,
which should stay thin wrappers that authenticate, validate and delegate.

`src/app/*` is routing and rendering only. `src/components/ui.tsx` holds the
shared primitives.

## Interface

Dark theme only, strictly monochrome: black grounds, grey surfaces and lines,
white and grey text. No light theme, no colour accent. Emphasis comes from
contrast (an inverted white fill, reserved for one primary action per screen)
and from weight. Status is always carried by a word, never by hue alone — every
screen must survive being read in greyscale. Tokens live in
`src/app/globals.css`; consume them through the primitives rather than
hardcoding hex values in components.

## Before you push

```bash
npm run typecheck && npm run lint && npm run build
```
