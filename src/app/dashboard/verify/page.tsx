import type { Metadata } from "next";

import { Badge, Card, CardHeader, Mono } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { canUseLiveMode, custodyPartnerConfigured } from "@/server/kyc";
import { kycIsLive } from "@/server/providers/kyc";
import { VerifyForm } from "./verify-form";

export const metadata: Metadata = { title: "Identity" };

export default async function VerifyPage() {
  const user = await requireUser();
  const liveCheck = await canUseLiveMode(user.id);
  const vendorLive = kycIsLive();
  const custody = custodyPartnerConfigured();

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-text text-2xl font-semibold tracking-tight">Identity</h1>
        <p className="text-text-dim mt-2 max-w-2xl text-sm leading-relaxed">
          One identity check, once. It is what makes live mode possible — the
          agent never has an identity of its own, it acts as a delegate under
          yours.
        </p>
      </div>

      <Card>
        <CardHeader
          title="Verification status"
          action={
            <Badge tone={user.kycStatus === "verified" ? "solid" : "outline"}>
              {user.kycStatus}
            </Badge>
          }
        />
        <div>
          <Row label="Vendor" value={user.kycVendor ?? "—"} />
          <Row
            label="Reference"
            value={user.kycVendorRef ? <Mono>{user.kycVendorRef}</Mono> : "—"}
          />
          <Row
            label="Identifier on file"
            value={user.kycMaskedTail ? <Mono>•••• {user.kycMaskedTail}</Mono> : "—"}
            note="Only the last four digits are ever stored. The full Aadhaar number or SSN never reaches this database."
          />
          <Row
            label="Verified at"
            value={user.kycVerifiedAt?.toISOString().slice(0, 10) ?? "—"}
          />
        </div>
        {user.kycStatus !== "verified" ? (
          <div className="border-line border-t p-5">
            {vendorLive ? (
              <p className="text-text-dim text-sm">
                A KYC vendor key is configured but no vendor integration is
                wired up yet, so verification cannot proceed here.
              </p>
            ) : (
              <>
                <p className="text-text-dim mb-4 text-sm leading-relaxed">
                  No KYC vendor is configured on this deployment, so this runs
                  the simulated check — it verifies instantly and proves nothing
                  about who you are. It exists so the live-mode gate can be
                  exercised end to end.
                </p>
                <VerifyForm label="Run simulated verification" />
              </>
            )}
          </div>
        ) : null}
      </Card>

      <Card>
        <CardHeader
          title="Live mode"
          description="Both gates must pass. Either one missing is a refusal, never a downgrade to sandbox behaviour on real money."
        />
        <div>
          <Row
            label="Identity verified"
            value={user.kycStatus === "verified" ? "yes" : "no"}
          />
          <Row
            label="Custody partner"
            value={custody ? "configured" : "not configured"}
            note={
              custody
                ? undefined
                : "Holding customer money in India is regulated under RBI's PPI rules. Skyborn never self-issues — a licensed partner's nodal account holds the funds and this ledger tracks each handle's claim on it."
            }
          />
          <Row
            label="Status"
            value={liveCheck.allowed ? "available" : "unavailable"}
            note={liveCheck.allowed ? undefined : liveCheck.reason}
          />
        </div>
      </Card>
    </div>
  );
}

function Row({
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
      <div className="max-w-md text-right">
        <div className="text-text text-sm">{value}</div>
        {note ? <p className="text-text-faint mt-1 text-xs leading-relaxed">{note}</p> : null}
      </div>
    </div>
  );
}
