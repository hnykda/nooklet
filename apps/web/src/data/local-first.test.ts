import { describe, expect, it, vi } from "vitest";
import { localFirst } from "./local-first.js";

describe("localFirst (B-641)", () => {
  it("answers from the device and never asks the server when the device can answer", async () => {
    const server = vi.fn(async () => "server");
    expect(
      await localFirst(
        async () => "device",
        server,
        () => true,
      ),
    ).toBe("device");
    expect(server).not.toHaveBeenCalled();
  });

  it("asks the server only when the device cannot answer and there is a server", async () => {
    const fail = async (): Promise<string> => {
      throw new Error("local_refs_unavailable");
    };
    expect(
      await localFirst(
        fail,
        async () => "server",
        () => true,
      ),
    ).toBe("server");
    // No server (local-only): the device's failure is the answer, shown as such by the panel.
    await expect(
      localFirst(
        fail,
        async () => "server",
        () => false,
      ),
    ).rejects.toThrow("local_refs_unavailable");
  });
});
