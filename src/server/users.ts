import bcrypt from "bcryptjs";
import { Prisma } from "@prisma/client";
import { z } from "zod";

import { prisma } from "@/lib/prisma";

export const signupSchema = z.object({
  name: z.string().trim().min(1, "Tell us your name.").max(80),
  email: z.string().trim().toLowerCase().email("That does not look like an email address."),
  password: z
    .string()
    .min(10, "Use at least 10 characters.")
    .max(200, "That password is too long."),
});

export type SignupInput = z.infer<typeof signupSchema>;

export class SignupError extends Error {}

export async function createUser(input: SignupInput) {
  const passwordHash = await bcrypt.hash(input.password, 12);
  try {
    return await prisma.user.create({
      data: {
        name: input.name,
        email: input.email,
        passwordHash,
        // kycStatus stays `unverified` until Phase 9 wires in the KYC vendor.
        // The raw Aadhaar/SSN is never stored — only the vendor's verdict.
      },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new SignupError("An account with that email already exists.");
    }
    throw error;
  }
}
