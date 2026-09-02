import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { extractOtp } from "@/server/otp";

/** Real-world shapes an OTP actually arrives in. */
const SHOULD_FIND: Array<[string, string]> = [
  ["Your OTP is 123456", "123456"],
  ["123456 is your verification code", "123456"],
  ["Use code 4821 to log in", "4821"],
  ["G-728431 is your Google verification code", "728431"],
  ["Your one-time passcode: 90210", "90210"],
  ["Enter 5567 to confirm your sign-in", "5567"],
  ["Your login code is 246 813", "246813"],
  ["OTP: 8391-22", "839122"],
  ["Your security code is 4429. Do not share it with anyone.", "4429"],
  ["<p>Your verification code is <b>771204</b></p>".replace(/<[^>]+>/g, " "), "771204"],
  ["Dear customer, 550132 is the OTP for your transaction of Rs 2,499 at Acme.", "550132"],
  ["Amazon: 217483 is your one time password. Valid for 10 minutes.", "217483"],
];

/** Numbers that must never be mistaken for a code. */
const SHOULD_NOT_FIND = [
  "Your order 45219 has shipped",
  "Your balance is ₹12,500 as of today",
  "Call us on +919876543210 for help",
  "Invoice 88123 is due on 2026-09-30",
  "Your package with tracking 9988776655 is out for delivery",
  "Meeting moved to 2026 in room 4021",
  "Thanks for shopping with us!",
  "Your card ending 4432 was charged ₹899",
  "Reference number 771204 for your complaint",
];

describe("extractOtp — finds real codes", () => {
  for (const [message, expected] of SHOULD_FIND) {
    it(JSON.stringify(message.slice(0, 52)), () => {
      const found = extractOtp(message);
      assert.ok(found, "expected a code");
      assert.equal(found.code, expected);
      assert.ok(found.confidence >= 0.5);
    });
  }
});

describe("extractOtp — refuses everything else", () => {
  for (const message of SHOULD_NOT_FIND) {
    it(JSON.stringify(message.slice(0, 52)), () => {
      assert.equal(extractOtp(message), null);
    });
  }
});

describe("extractOtp — edge cases", () => {
  it("returns null on empty input", () => {
    assert.equal(extractOtp(""), null);
  });

  it("prefers the code over an amount in the same message", () => {
    const found = extractOtp("OTP 448120 for your payment of Rs 15000 to Acme");
    assert.equal(found?.code, "448120");
  });

  it("carries context for the audit log", () => {
    const found = extractOtp("Your verification code is 662301, valid 10 minutes");
    assert.ok(found?.context.includes("662301"));
  });

  it("does not read a code out of a bare number with no code word", () => {
    assert.equal(extractOtp("123456"), null);
  });

  it("picks the code, not the order id, when a message carries both", () => {
    const found = extractOtp("Your OTP is 445566 for order 99887");
    assert.equal(found?.code, "445566");
  });

  it("ignores a labelled reference even next to a code word", () => {
    assert.equal(extractOtp("Verification pending for reference 771204"), null);
  });

  it("survives a code at the very end with no trailing punctuation", () => {
    assert.equal(extractOtp("Your verification code is 998877")?.code, "998877");
  });

  it("does not treat a decimal amount as a code", () => {
    assert.equal(extractOtp("Your code was used for a payment of 1234.56"), null);
  });
});
