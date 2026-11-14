import { describe, expect, it } from "vitest";

import { GET } from "@/app/(site)/desktop/latest.json/route";

import { DEFAULT_UPDATE_MANIFEST, updateManifestUrl } from "./desktop-updates";

describe("desktop update manifest", () => {
  it("redirects installed apps to the newest GitHub Release by default", () => {
    const response = GET();
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(DEFAULT_UPDATE_MANIFEST);
  });

  it("follows DESKTOP_UPDATE_MANIFEST_URL when it's https", () => {
    expect(updateManifestUrl("https://files.example.com/neb/latest.json")).toBe(
      "https://files.example.com/neb/latest.json",
    );
  });

  it("ignores an address that isn't https", () => {
    expect(updateManifestUrl("http://files.example.com/latest.json")).toBe(DEFAULT_UPDATE_MANIFEST);
    expect(updateManifestUrl("not a url")).toBe(DEFAULT_UPDATE_MANIFEST);
    expect(updateManifestUrl("  ")).toBe(DEFAULT_UPDATE_MANIFEST);
  });
});
