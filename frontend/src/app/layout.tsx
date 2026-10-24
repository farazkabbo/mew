import { ClerkProvider } from "@clerk/nextjs";
import type { Metadata, Viewport } from "next";
import { Instrument_Serif, Inter } from "next/font/google";
import { connection } from "next/server";

import { isClerkConfigured } from "@/lib/auth-mode";

import "./globals.css";

const inter = Inter({ variable: "--font-inter", subsets: ["latin"] });
const instrumentSerif = Instrument_Serif({
  variable: "--font-instrument-serif",
  subsets: ["latin"],
  weight: "400",
});

export const metadata: Metadata = {
  title: "Neb",
  description: "A quiet tutor that lives in your notebook.",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f7f5f0" },
    { media: "(prefers-color-scheme: dark)", color: "#1b1a18" },
  ],
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  // Every page renders per request so it can carry the CSP nonce set in proxy.ts.
  await connection();

  return (
    <html lang="en" className={`${inter.variable} ${instrumentSerif.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col font-sans">
        {isClerkConfigured ? <ClerkProvider dynamic>{children}</ClerkProvider> : children}
      </body>
    </html>
  );
}
