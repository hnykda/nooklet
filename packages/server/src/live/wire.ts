/**
 * `LiveWindowRecord` -> wire shape helpers shared by the five `ui.*` ops.
 */

import type { SqlDriver } from "@nooklet/core";
import type { z } from "zod";
import type { LiveWindowRecord } from "./registry.js";
import type { OtherWindow, WindowSummary } from "./schemas.js";

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function deviceLabel(driver: SqlDriver, deviceId: string): string | undefined {
  return driver.get<{ name: string }>("SELECT name FROM device WHERE id = ?", [deviceId])?.name;
}

export function toWindowSummary(
  driver: SqlDriver,
  w: LiveWindowRecord,
): z.output<typeof WindowSummary> {
  return {
    window_id: w.windowId,
    device_id: w.deviceId,
    device_label: deviceLabel(driver, w.deviceId),
    focused: w.focused,
    page: w.page,
    control_enabled: w.controlEnabled,
    connected_at: iso(w.connectedAt),
    last_active_at: iso(w.lastActiveAt),
  };
}

export function toOtherWindow(w: LiveWindowRecord): z.output<typeof OtherWindow> {
  return { window_id: w.windowId, page: w.page?.name ?? null };
}
