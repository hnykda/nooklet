// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { insertAt, pickImageFile } from "./imagePicker.js";

describe("pickImageFile (/image, B-99)", () => {
  it("asks for one image through a connected file input and cleans it up", async () => {
    const click = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => {});
    const picked = pickImageFile();
    const input = document.querySelector<HTMLInputElement>("input[data-nooklet-image-picker]");
    expect(input?.type).toBe("file");
    expect(input?.accept).toBe("image/*");
    expect(input?.multiple).toBe(false);
    expect(click).toHaveBeenCalledOnce();

    const file = new File(["x"], "dot.png", { type: "image/png" });
    Object.defineProperty(input, "files", { value: [file] });
    input?.dispatchEvent(new Event("change"));
    await expect(picked).resolves.toBe(file);
    expect(document.querySelector("input[data-nooklet-image-picker]")).toBeNull();
    click.mockRestore();
  });

  it("resolves null when the chooser is dismissed", async () => {
    const click = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => {});
    const picked = pickImageFile();
    document.querySelector("input[data-nooklet-image-picker]")?.dispatchEvent(new Event("cancel"));
    await expect(picked).resolves.toBeNull();
    expect(document.querySelector("input[data-nooklet-image-picker]")).toBeNull();
    click.mockRestore();
  });
});

describe("insertAt", () => {
  it("inserts at an offset, clamped to the content", () => {
    expect(insertAt("look here", 5, "![](a.png) ")).toBe("look ![](a.png) here");
    expect(insertAt("short", 99, "!")).toBe("short!");
    expect(insertAt("short", -3, "!")).toBe("!short");
  });
});
