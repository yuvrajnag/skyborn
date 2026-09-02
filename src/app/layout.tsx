import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Skyborn",
    template: "%s · Skyborn",
  },
  description:
    "Verify once, fund once. After that your agent operates on its own — money, email, SMS and calls, machine to machine.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="h-full">
      <body className="bg-ink text-text flex min-h-full flex-col">{children}</body>
    </html>
  );
}
