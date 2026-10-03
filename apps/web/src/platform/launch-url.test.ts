// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { claimLaunchUrl, markUrlHandled } from "./launch-url.js";

beforeEach(() => sessionStorage.clear());

describe("claimLaunchUrl (B-603: the launch URL outlives a reload)", () => {
  it("hands a launch URL out once per page session — a reload must not re-open the pairing prompt", () => {
    const link = "nooklet://connect?url=http%3A%2F%2Fh%3A1&token=nk_abcdefgh";
    expect(claimLaunchUrl(link, sessionStorage)).toBe(true);
    expect(claimLaunchUrl(link, sessionStorage)).toBe(false); // the reloaded page
    expect(claimLaunchUrl("nooklet://connect?other", sessionStorage)).toBe(true);
  });

  it("a URL delivered live (appUrlOpen) is not re-delivered by getLaunchUrl() after a reload", () => {
    const link = "nooklet://connect?url=http%3A%2F%2Fh%3A1&token=nk_abcdefgh";
    markUrlHandled(link, sessionStorage); // warm open while the app was running
    expect(claimLaunchUrl(link, sessionStorage)).toBe(false); // getLaunchUrl() == lastURL
  });

  it("never stores the URL itself (a pairing link carries a token)", () => {
    claimLaunchUrl("nooklet://connect?token=nk_secretsecret", sessionStorage);
    expect(JSON.stringify({ ...sessionStorage })).not.toContain("nk_secret");
  });

  it("handles the URL when storage is unavailable", () => {
    expect(claimLaunchUrl("nooklet://x", undefined)).toBe(true);
  });
});
