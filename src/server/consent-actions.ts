"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { requireUser } from "@/lib/auth";
import { GrantError, approveGrant, denyGrant, revokeGrantForUser } from "@/server/grants";
import { registerDevApp } from "@/server/grants";
import type { FormState } from "@/server/actions";

function message(error: unknown, fallback: string) {
  if (error instanceof GrantError) return error.message;
  console.error(error);
  return fallback;
}

export async function approveGrantAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requireUser();
  const grantId = String(formData.get("grantId") ?? "");

  try {
    await approveGrant({ grantId, approvingUserId: user.id });
  } catch (error) {
    return { error: message(error, "Could not approve that grant.") };
  }

  revalidatePath(`/consent/${grantId}`);
  revalidatePath("/dashboard/grants");
  redirect(`/consent/${grantId}?approved=1`);
}

export async function denyGrantAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requireUser();
  const grantId = String(formData.get("grantId") ?? "");

  try {
    await denyGrant({ grantId, approvingUserId: user.id });
  } catch (error) {
    return { error: message(error, "Could not deny that grant.") };
  }

  revalidatePath(`/consent/${grantId}`);
  redirect(`/consent/${grantId}?denied=1`);
}

export async function revokeGrantAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requireUser();
  const grantId = String(formData.get("grantId") ?? "");

  try {
    await revokeGrantForUser({ grantId, userId: user.id });
  } catch (error) {
    return { error: message(error, "Could not revoke that grant.") };
  }

  revalidatePath("/dashboard/grants");
  return {};
}

export type CreateAppState =
  | { error?: string; created?: { name: string; clientId: string; clientSecret: string; sandboxKeySecret: string } }
  | undefined;

export async function createDevAppAction(
  _prev: CreateAppState,
  formData: FormData,
): Promise<CreateAppState> {
  const user = await requireUser();

  try {
    const { devApp, clientSecret, sandboxKeySecret } = await registerDevApp({
      userId: user.id,
      name: String(formData.get("name") ?? ""),
    });

    revalidatePath("/dashboard/apps");

    // The secrets are returned here and nowhere else — only their hashes are
    // stored, so this is the one moment they can be shown.
    return {
      created: {
        name: devApp.name,
        clientId: devApp.clientId,
        clientSecret,
        sandboxKeySecret,
      },
    };
  } catch (error) {
    return { error: message(error, "Could not create that app.") };
  }
}
