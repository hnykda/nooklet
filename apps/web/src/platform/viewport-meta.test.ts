import { describe, expect, it } from "vitest";
import { withMaximumScale } from "./viewport-meta.js";

describe("withMaximumScale (B-705)", () => {
  it("adds maximum-scale=1 to the app's viewport", () => {
    expect(
      withMaximumScale(
        "width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content",
      ),
    ).toBe(
      "width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content, maximum-scale=1",
    );
  });

  it("leaves one that already has a maximum-scale alone", () => {
    expect(withMaximumScale("width=device-width, maximum-scale=2")).toBe(
      "width=device-width, maximum-scale=2",
    );
  });
});
