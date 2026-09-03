"use server";

import { revalidatePath } from "next/cache";

import { requireUser } from "@/lib/auth";
import { KycError, completeKyc, startKyc } from "@/server/kyc";
import type { FormState } from "@/server/actions";

export async function startKycAction(
  _prev: FormState,
  _formData: FormData,
): Promise<FormState> {
  const user = await requireUser();

  try {
    await startKyc({
      userId: user.id,
      redirectUrl: `${process.env.NEXTAUTH_URL ?? "http://localhost:3000"}/dashboard/verify`,
    });
    // The simulated vendor verifies immediately; a real one would return here
    // only after the human finished the vendor's own hosted flow.
    await completeKyc(user.id);
  } catch (error) {
    if (error instanceof KycError) return { error: error.message };
    return {
      error:
        error instanceof Error
          ? error.message
          : "Could not start identity verification.",
    };
  }

  revalidatePath("/dashboard/verify");
  return {};
}
