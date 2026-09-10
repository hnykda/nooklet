/**
 * `device` row bookkeeping for the sync protocol (`docs/spec/sql-schema.md` rule 22): touched by
 * `/sync/push` (registers an unknown device, bumps `last_seen_at`) and `/sync/pull` (advances
 * `acked_seq`, the GC floor mentioned in research/03-sync.md §6.5).
 */

import type { SqlDriver } from "@nooklet/core";

export interface DeviceIdentity {
  tokenId: string;
  /** Used as the new `device.name` only when the device row does not already exist. */
  defaultName: string;
}

/** Upsert a `device` row on push: create it (name defaults to the token label) if unknown, and
 * always bump `last_seen_at`. Never touches `acked_seq` on an existing row. */
export function touchDeviceOnPush(
  driver: SqlDriver,
  deviceId: string,
  identity: DeviceIdentity,
  now: number = Date.now(),
): void {
  driver.run(
    `INSERT INTO device(id, name, token_id, created_at, last_seen_at, acked_seq)
     VALUES (?, ?, ?, ?, ?, 0)
     ON CONFLICT(id) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
    [deviceId, identity.defaultName, identity.tokenId, now, now],
  );
}

/** Upsert a `device` row on pull, advancing `acked_seq` to `cursor` — but only ever forward
 * (`MAX`), since a pull with an older `since` can report a `cursor` behind what this device has
 * already acknowledged. */
export function advanceAckedSeq(
  driver: SqlDriver,
  deviceId: string,
  cursor: number,
  identity: DeviceIdentity,
  now: number = Date.now(),
): void {
  driver.run(
    `INSERT INTO device(id, name, token_id, created_at, last_seen_at, acked_seq)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       last_seen_at = excluded.last_seen_at,
       acked_seq = MAX(device.acked_seq, excluded.acked_seq)`,
    [deviceId, identity.defaultName, identity.tokenId, now, now, cursor],
  );
}
