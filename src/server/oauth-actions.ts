"use server";

import { redirect } from "next/navigation";

import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { approveGrant } from "@/server/grants";
import {
  OAuthError,
  beginAuthorization,
  issueAuthorizationCode,
} from "@/server/oauth";
import type { FormState } from "@/server/actions";

/**
 * The MCP consent decision. Approving mints the authorization code and sends
 * the browser back to the client's redirect URI — the last time this human is
 * involved until they revoke.
 */
export async function approveOAuthAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requireUser();

  const clientId = String(formData.get("clientId") ?? "");
  const agentId = String(formData.get("agentId") ?? "");
  const redirectUri = String(formData.get("redirectUri") ?? "");
  const state = String(formData.get("state") ?? "");
  const codeChallenge = String(formData.get("codeChallenge") ?? "");
  const scopes = String(formData.get("scopes") ?? "").split(/[\s,]+/).filter(Boolean);
  const capRaw = String(formData.get("spendingCapPaise") ?? "").trim();

  let target: string;
  try {
    // The agent must belong to the human doing the approving.
    const agent = await prisma.agent.findFirst({ where: { id: agentId, userId: user.id } });
    if (!agent) return { error: "That agent is not yours." };

    const { devApp, grant } = await beginAuthorization({
      clientId,
      agentId,
      redirectUri,
      scopes,
      codeChallenge,
      codeChallengeMethod: "S256",
      spendingCapPaise: capRaw && /^\d+$/.test(capRaw) ? BigInt(capRaw) : null,
    });

    await approveGrant({ grantId: grant.id, approvingUserId: user.id });

    const code = await issueAuthorizationCode({
      grantId: grant.id,
      devAppId: devApp.id,
      redirectUri,
      codeChallenge,
      scopes: grant.scopes,
    });

    const url = new URL(redirectUri);
    url.searchParams.set("code", code);
    if (state) url.searchParams.set("state", state);
    target = url.toString();
  } catch (error) {
    if (error instanceof OAuthError) return { error: error.message };
    console.error(error);
    return { error: "Could not complete that authorization." };
  }

  redirect(target);
}

/** Denying sends the client an `access_denied` error, per RFC 6749 §4.1.2.1. */
export async function denyOAuthAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  await requireUser();

  const redirectUri = String(formData.get("redirectUri") ?? "");
  const state = String(formData.get("state") ?? "");

  let target: string;
  try {
    const url = new URL(redirectUri);
    url.searchParams.set("error", "access_denied");
    url.searchParams.set("error_description", "The handle's owner denied the request.");
    if (state) url.searchParams.set("state", state);
    target = url.toString();
  } catch {
    return { error: "That redirect URI is not valid." };
  }

  redirect(target);
}
