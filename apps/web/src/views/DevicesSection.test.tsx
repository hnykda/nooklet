// @vitest-environment jsdom
/**
 * Settings → Devices (B-655): hidden from a non-admin session, lists tokens, revokes after an
 * in-app confirm, and shows a QR + URL + countdown for a new pairing code.
 */
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../data/api-client.js";

const api = vi.hoisted(() => ({
  listDevices: vi.fn(),
  revokeDevice: vi.fn(),
  createPairingCode: vi.fn(),
}));
vi.mock("../data/pairing.js", async (orig) => ({
  ...(await orig<typeof import("../data/pairing.js")>()),
  ...api,
}));
const confirm = vi.hoisted(() => vi.fn());
vi.mock("../app/confirm-dialog.js", () => ({ confirmDialog: confirm }));

import { DevicesSection } from "./DevicesSection.js";

const PHONE = {
  id: "t-phone",
  label: "Test phone",
  scope: "write",
  sync: true,
  ui_control: false,
  created_at: 1,
  last_used_at: null,
  revoked_at: null,
  current: false,
};
const ME = { ...PHONE, id: "t-me", label: "web-client (auto)", scope: "admin", current: true };

beforeEach(() => {
  for (const f of Object.values(api)) f.mockReset();
  confirm.mockReset();
  localStorage.clear();
});
afterEach(() => cleanup());

describe("DevicesSection (B-655)", () => {
  it("renders nothing for a session without admin (403 from token.list)", async () => {
    api.listDevices.mockRejectedValue(new ApiError("forbidden", "requires scope(s): admin"));
    const { container } = render(() => <DevicesSection />);
    await vi.waitFor(() => expect(api.listDevices).toHaveBeenCalled());
    await Promise.resolve();
    expect(container.textContent).toBe("");
  });

  it("lists devices; this session has no Revoke; Revoke asks first and only then revokes", async () => {
    api.listDevices.mockResolvedValue([ME, PHONE]);
    render(() => <DevicesSection />);
    const rows = await screen.findAllByTestId("device-row");
    expect(rows).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "Revoke" })).toHaveLength(1);

    confirm.mockResolvedValueOnce(false);
    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    await vi.waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    expect(api.revokeDevice).not.toHaveBeenCalled();

    confirm.mockResolvedValueOnce(true);
    api.listDevices.mockResolvedValue([ME]);
    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    await vi.waitFor(() => expect(api.revokeDevice).toHaveBeenCalledWith("t-phone"));
    await vi.waitFor(() => expect(screen.getAllByTestId("device-row")).toHaveLength(1));
  });

  it("Add a device shows a QR, the page URL with the code in its fragment, and a countdown", async () => {
    api.listDevices.mockResolvedValue([ME]);
    api.createPairingCode.mockResolvedValue({
      code: "nkp_abcdefghijklmnopqrstuv",
      expires_at: Date.now() + 600_000,
    });
    render(() => <DevicesSection />);
    fireEvent.click(await screen.findByRole("button", { name: "Add a device" }));
    const address = screen.getByLabelText(
      "Address your phone uses to reach this server",
    ) as HTMLInputElement;
    fireEvent.input(address, { target: { value: "https://n.example.ts.net" } });
    fireEvent.click(screen.getByRole("button", { name: "Show pairing code" }));
    const url = await screen.findByTestId("pairing-url");
    expect(url.textContent).toBe(
      "https://n.example.ts.net/g/default/pair#code=nkp_abcdefghijklmnopqrstuv",
    );
    const img = screen.getByAltText("Pairing QR code") as HTMLImageElement;
    expect(img.src.startsWith("data:image/svg+xml")).toBe(true);
    expect(screen.getByTestId("pairing-countdown").textContent).toMatch(/^(10:00|9:5\d)$/);
  });
});
