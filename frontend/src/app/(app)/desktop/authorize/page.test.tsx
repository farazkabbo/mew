import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import AuthorizeDesktopPage from "./page";

vi.mock("@clerk/nextjs/server", () => ({
  auth: async () => ({ userId: "local-test-user" }),
}));
vi.mock("@clerk/nextjs", () => ({
  useClerk: () => ({ signOut: vi.fn() }),
  useUser: () => ({ user: null }),
}));
vi.mock("@/lib/auth-mode", () => ({ isClerkConfigured: true }));

describe("desktop browser confirmation", () => {
  it.each([
    { device: "mac", label: "a Mac" },
    { device: "windows", label: "a Windows PC" },
    { device: undefined, label: "this computer" },
    { device: "linux", label: "this computer" },
    { device: ["mac", "windows"], label: "this computer" },
  ])("uses '$label' for device=$device", async ({ device, label }) => {
    const page = await AuthorizeDesktopPage({
      searchParams: Promise.resolve({
        challenge: "c".repeat(43),
        ...(device === undefined ? {} : { device }),
      }),
    });

    expect(renderToStaticMarkup(page)).toContain(`Connect neb on ${label}?`);
  });
});
