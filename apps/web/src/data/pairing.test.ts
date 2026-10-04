import { describe, expect, it } from "vitest";
import {
  defaultDeviceLabel,
  isPairPath,
  pairCodeFromHash,
  pairingAppLink,
  pairingPageUrl,
} from "./pairing.js";

const CODE = "nkp_abcdefghijklmnopqrstuv";

describe("QR pairing URLs (B-655)", () => {
  it("the page URL keeps the code in the fragment; the app link carries it as code=", () => {
    const page = new URL(pairingPageUrl("https://n.example.ts.net/g/default/", CODE));
    expect(page.pathname).toBe("/g/default/pair");
    expect(page.search).toBe("");
    expect(pairCodeFromHash(page.hash)).toBe(CODE);

    const app = new URL(pairingAppLink("https://n.example.ts.net/g/default", CODE));
    expect(app.protocol).toBe("nooklet:");
    expect(app.searchParams.get("url")).toBe("https://n.example.ts.net/g/default");
    expect(app.searchParams.get("code")).toBe(CODE);
  });

  it("recognises the pairing page path and refuses a malformed code", () => {
    expect(isPairPath("/g/default/pair")).toBe(true);
    expect(isPairPath("/proxy/g/work/pair/")).toBe(true);
    expect(isPairPath("/g/default/page/pair%20programming")).toBe(false);
    expect(isPairPath("/g/default/page/pair")).toBe(false); // a page called "pair"
    expect(isPairPath("/g/default/journals")).toBe(false);
    expect(pairCodeFromHash("#code=nk_token")).toBeUndefined();
    expect(pairCodeFromHash("")).toBeUndefined();
  });

  it("names a device after its platform", () => {
    expect(defaultDeviceLabel("Mozilla/5.0 (iPhone; CPU iPhone OS 26_5 like Mac OS X)")).toBe(
      "iPhone",
    );
    expect(defaultDeviceLabel("Mozilla/5.0 (Linux; Android 16)")).toBe("Android");
    expect(defaultDeviceLabel("curl/8")).toBe("New device");
  });
});
