import { randomUUID } from "node:crypto";

/**
 * The handle's email address, phone number and voice line (spec Section 6).
 *
 * Postmark provides inbound-parsing plus send; Twilio provides the number,
 * SMS in/out and Voice. Both sit behind this seam so Phase 1's internal
 * placeholders, a simulated driver in tests, and the real providers are the
 * same shape to the service layer.
 *
 * As with payments, the simulated driver is chosen only when credentials are
 * absent, and the real drivers refuse rather than silently pretending.
 */

export type ProvisionedAddress = {
  address: string;
  providerRef: string;
};

export type SendResult = {
  providerRef: string;
  status: "queued" | "sent" | "failed";
  failureCode?: string;
};

export interface EmailProvider {
  readonly id: string;
  provisionAddress(params: { slug: string; agentId: string }): Promise<ProvisionedAddress>;
  send(params: {
    from: string;
    to: string;
    subject: string;
    body: string;
  }): Promise<SendResult>;
}

export interface PhoneProvider {
  readonly id: string;
  provisionNumber(params: { agentId: string; areaCode?: string }): Promise<ProvisionedAddress>;
  sendSms(params: { from: string; to: string; body: string }): Promise<SendResult>;
  placeCall(params: { from: string; to: string; script: string }): Promise<SendResult>;
}

const SIMULATED_EMAIL_DOMAIN =
  process.env.SKYBORN_HANDLE_EMAIL_DOMAIN ?? "agents.skyborn.local";

/**
 * Records what would have been sent and reports success. Nothing leaves the
 * process. Addresses stay on the reserved `.local` domain and the unassigned
 * +99 country code so a simulated handle can never be confused for a real one.
 */
export class SimulatedEmailProvider implements EmailProvider {
  readonly id = "simulated";

  async provisionAddress(params: { slug: string; agentId: string }): Promise<ProvisionedAddress> {
    const discriminator = params.agentId.slice(-6).toLowerCase();
    return {
      address: `${params.slug}.${discriminator}@${SIMULATED_EMAIL_DOMAIN}`,
      providerRef: `sim_inbox_${discriminator}`,
    };
  }

  async send(): Promise<SendResult> {
    return { providerRef: `sim_email_${randomUUID().slice(0, 12)}`, status: "sent" };
  }
}

export class SimulatedPhoneProvider implements PhoneProvider {
  readonly id = "simulated";

  async provisionNumber(params: { agentId: string }): Promise<ProvisionedAddress> {
    // Deterministic in the agent id so re-provisioning is stable in tests.
    let digits = "";
    for (const ch of params.agentId.slice(-10).padStart(10, "0")) {
      digits += (ch.charCodeAt(0) % 10).toString();
    }
    return { address: `+99${digits}`, providerRef: `sim_number_${digits}` };
  }

  async sendSms(): Promise<SendResult> {
    return { providerRef: `sim_sms_${randomUUID().slice(0, 12)}`, status: "sent" };
  }

  async placeCall(): Promise<SendResult> {
    return { providerRef: `sim_call_${randomUUID().slice(0, 12)}`, status: "queued" };
  }
}

export class MessagingProviderError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

/**
 * Postmark-backed email. Unimplemented on purpose: reporting a send that never
 * happened is worse than refusing, particularly for an OTP an agent is waiting
 * on. Wire the real calls when a Postmark server token exists.
 */
export class PostmarkEmailProvider implements EmailProvider {
  readonly id = "postmark";

  constructor(private readonly serverToken: string) {}

  private notWired(operation: string): never {
    throw new MessagingProviderError(
      `Postmark ${operation} is not wired up yet. A POSTMARK_SERVER_TOKEN is set, so refusing rather than simulating a real send.`,
      "PROVIDER_NOT_IMPLEMENTED",
    );
  }

  async provisionAddress(): Promise<ProvisionedAddress> {
    this.notWired("inbound address provisioning");
  }

  async send(): Promise<SendResult> {
    this.notWired("send");
  }
}

/** Twilio-backed number, SMS and Voice. Same refusal contract as Postmark. */
export class TwilioPhoneProvider implements PhoneProvider {
  readonly id = "twilio";

  constructor(
    private readonly accountSid: string,
    private readonly authToken: string,
  ) {}

  private notWired(operation: string): never {
    throw new MessagingProviderError(
      `Twilio ${operation} is not wired up yet. Credentials are set, so refusing rather than simulating.`,
      "PROVIDER_NOT_IMPLEMENTED",
    );
  }

  async provisionNumber(): Promise<ProvisionedAddress> {
    this.notWired("number provisioning");
  }

  async sendSms(): Promise<SendResult> {
    this.notWired("SMS send");
  }

  async placeCall(): Promise<SendResult> {
    this.notWired("voice call");
  }
}

export function emailProvider(): EmailProvider {
  const token = process.env.POSTMARK_SERVER_TOKEN;
  return token ? new PostmarkEmailProvider(token) : new SimulatedEmailProvider();
}

export function phoneProvider(): PhoneProvider {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  return sid && token ? new TwilioPhoneProvider(sid, token) : new SimulatedPhoneProvider();
}

/** True when both handles would be backed by a real provider. */
export function messagingIsLive(): boolean {
  return emailProvider().id !== "simulated" && phoneProvider().id !== "simulated";
}
