import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { MessageChannel, MessageDirection } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  getLatestOtp,
  provisionHandle,
  readInbox,
  recordInboundMessage,
  sendEmail,
  sendSms,
  makeCall,
} from "@/server/messaging";
import { makeAgent } from "./helpers";

after(async () => {
  await prisma.$disconnect();
});

describe("handle provisioning", () => {
  it("stays unprovisioned while the simulated drivers are in use", async () => {
    const { agent } = await makeAgent("Provisioning Agent");
    const handle = await provisionHandle(agent.id);

    assert.equal(handle.provisioned, false);
    assert.ok(handle.emailProviderRef?.startsWith("sim_inbox_"));
    assert.ok(handle.phoneProviderRef?.startsWith("sim_number_"));
    assert.ok(handle.phone.startsWith("+99"), "placeholder numbers stay on +99");
  });
});

describe("outbound", () => {
  it("records email, SMS and calls against the agent", async () => {
    const { agent } = await makeAgent("Outbound Agent");

    await sendEmail({ agentId: agent.id, to: "shop@example.com", subject: "Order", body: "Hello" });
    await sendSms({ agentId: agent.id, to: "+911234567890", body: "On my way" });
    await makeCall({ agentId: agent.id, to: "+911234567890", script: "Confirm the booking" });

    const out = await readInbox({ agentId: agent.id, direction: MessageDirection.out });
    assert.equal(out.length, 3);
    assert.deepEqual(
      out.map((m) => m.channel).sort(),
      [MessageChannel.call, MessageChannel.email, MessageChannel.sms],
    );
    assert.ok(out.every((m) => m.providerRef));
  });
});

describe("getLatestOtp", () => {
  async function agentWithMessages(bodies: Array<{ body: string; minutesAgo?: number; from?: string }>) {
    const { agent } = await makeAgent("OTP Agent");
    for (const entry of bodies) {
      await recordInboundMessage({
        agentId: agent.id,
        channel: MessageChannel.sms,
        from: entry.from ?? "VM-ACME",
        to: "+990000000000",
        body: entry.body,
        receivedAt: new Date(Date.now() - (entry.minutesAgo ?? 0) * 60_000),
      });
    }
    return agent;
  }

  it("returns the newest code", async () => {
    const agent = await agentWithMessages([
      { body: "Your OTP is 111111", minutesAgo: 5 },
      { body: "Your OTP is 222222", minutesAgo: 1 },
    ]);

    const otp = await getLatestOtp({ agentId: agent.id });
    assert.equal(otp?.code, "222222");
  });

  it("skips messages that carry no code", async () => {
    const agent = await agentWithMessages([
      { body: "Your OTP is 333333", minutesAgo: 3 },
      { body: "Your order 88991 has shipped", minutesAgo: 1 },
    ]);

    const otp = await getLatestOtp({ agentId: agent.id });
    assert.equal(otp?.code, "333333");
  });

  it("ignores a stale code rather than returning one that will be rejected", async () => {
    const agent = await agentWithMessages([{ body: "Your OTP is 444444", minutesAgo: 60 }]);

    assert.equal(await getLatestOtp({ agentId: agent.id }), null);
    assert.equal((await getLatestOtp({ agentId: agent.id, withinMinutes: 120 }))?.code, "444444");
  });

  it("never reads a code out of the agent's own outbound message", async () => {
    const { agent } = await makeAgent("Self OTP Agent");
    await sendSms({ agentId: agent.id, to: "+911234567890", body: "Your OTP is 555555" });

    assert.equal(await getLatestOtp({ agentId: agent.id }), null);
  });

  it("filters by sender", async () => {
    const agent = await agentWithMessages([
      { body: "Your OTP is 666666", from: "VM-BANKA", minutesAgo: 2 },
      { body: "Your OTP is 777777", from: "VM-SHOPB", minutesAgo: 1 },
    ]);

    assert.equal((await getLatestOtp({ agentId: agent.id, from: "BANKA" }))?.code, "666666");
    assert.equal((await getLatestOtp({ agentId: agent.id, from: "SHOPB" }))?.code, "777777");
  });

  it("filters by channel", async () => {
    const { agent } = await makeAgent("Channel OTP Agent");
    await recordInboundMessage({
      agentId: agent.id,
      channel: MessageChannel.email,
      from: "noreply@bank.example",
      to: "a@b.local",
      subject: "Your verification code",
      body: "Use 246813 to continue",
    });

    assert.equal((await getLatestOtp({ agentId: agent.id, channel: MessageChannel.email }))?.code, "246813");
    assert.equal(await getLatestOtp({ agentId: agent.id, channel: MessageChannel.sms }), null);
  });

  it("reads a code that only appears in an email subject", async () => {
    const { agent } = await makeAgent("Subject OTP Agent");
    await recordInboundMessage({
      agentId: agent.id,
      channel: MessageChannel.email,
      from: "noreply@bank.example",
      to: "a@b.local",
      subject: "918273 is your verification code",
      body: "Do not share this with anyone.",
    });

    assert.equal((await getLatestOtp({ agentId: agent.id }))?.code, "918273");
  });

  it("scopes strictly to one agent", async () => {
    const agent = await agentWithMessages([{ body: "Your OTP is 121212" }]);
    const { agent: other } = await makeAgent("Other OTP Agent");

    assert.equal((await getLatestOtp({ agentId: agent.id }))?.code, "121212");
    assert.equal(await getLatestOtp({ agentId: other.id }), null);
  });
});
