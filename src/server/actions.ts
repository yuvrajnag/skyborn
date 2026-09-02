"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { requireUser } from "@/lib/auth";
import { MoneyParseError, rupeesToPaise } from "@/lib/money";
import { AgentBirthError, birthAgent, getAgentForUser } from "@/server/agents";
import { SignupError, createUser, signupSchema } from "@/server/users";
import { WalletError, creditWalletManually } from "@/server/wallet";

export type FormState = { error?: string } | undefined;

function messageFor(error: unknown, fallback: string): string {
  if (
    error instanceof AgentBirthError ||
    error instanceof WalletError ||
    error instanceof SignupError ||
    error instanceof MoneyParseError
  ) {
    return error.message;
  }
  console.error(error);
  return fallback;
}

export async function signupAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = signupSchema.safeParse({
    name: formData.get("name"),
    email: formData.get("email"),
    password: formData.get("password"),
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Check the form and try again." };
  }

  try {
    await createUser(parsed.data);
  } catch (error) {
    return { error: messageFor(error, "Could not create that account.") };
  }

  redirect(`/signin?registered=1&email=${encodeURIComponent(parsed.data.email)}`);
}

export async function birthAgentAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requireUser();
  const name = String(formData.get("name") ?? "");

  let agentId: string;
  try {
    const agent = await birthAgent({ userId: user.id, name });
    agentId = agent.id;
  } catch (error) {
    return { error: messageFor(error, "Could not create that agent.") };
  }

  revalidatePath("/dashboard");
  redirect(`/dashboard/agents/${agentId}`);
}

export async function creditWalletAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requireUser();
  const agentId = String(formData.get("agentId") ?? "");

  // Scope the wallet through the agent's owner — an id in a form field is not
  // an authorization.
  const agent = await getAgentForUser(user.id, agentId);
  if (!agent?.wallet) return { error: "That agent does not exist." };

  try {
    const amountPaise = rupeesToPaise(String(formData.get("amount") ?? ""));
    await creditWalletManually({
      walletId: agent.wallet.id,
      amountPaise,
      description: String(formData.get("description") ?? "") || undefined,
    });
  } catch (error) {
    return { error: messageFor(error, "Could not credit that wallet.") };
  }

  revalidatePath(`/dashboard/agents/${agentId}`);
  revalidatePath("/dashboard");
  return {};
}
