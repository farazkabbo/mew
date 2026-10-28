import { ClerkProvider } from "@clerk/nextjs";
import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { connection } from "next/server";

import { isClerkConfigured } from "@/lib/auth-mode";
import { DISPLAY_SCRIPT } from "@/lib/display";

import { fontVariables } from "./fonts";
import "./globals.css";

export const metadata: Metadata = {
  title: "Neb",
  description: "A quiet tutor that lives in your notebook.",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ECE6D8" },
    { media: "(prefers-color-scheme: dark)", color: "#1B1F23" },
  ],
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  // Every page renders per request so it can carry the CSP nonce set in proxy.ts.
  await connection();
  const nonce = (await headers()).get("x-nonce") ?? undefined;

  return (
    <html lang="en" className={`${fontVariables} h-full antialiased`} suppressHydrationWarning>
      <head>
        {/* Appearance and text size before the first paint (NEB_APP_UI §3.1, §3.10). */}
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: DISPLAY_SCRIPT }} />
      </head>
      <body className="flex min-h-full flex-col font-sans">
        {isClerkConfigured ? <ClerkProvider dynamic>{children}</ClerkProvider> : children}
      </body>
    </html>
  );
}
