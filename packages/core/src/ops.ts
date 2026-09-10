/**
 * The op log: every write anywhere (editor, API, MCP, markdown import) is a list of ops.
 *
 * Each op targets one entity and one independently mergeable field. Fields are
 * last-writer-wins by HLC. Structure (page/parent/pos) is one field so a move is atomic.
 * Reserved block properties "marker", "priority", "collapsed" are ordinary `block.prop`
 * ops on the wire but are stored in dedicated columns for querying.
 */

import { isHlc } from "./hlc.js";
import { isUuid } from "./ids.js";
import type { Priority, Properties, TaskMarker } from "./model.js";

export interface BlockPlace {
  pageId: string;
  parentId: string | null;
  order: string;
}

export type OpPayload =
  | {
      kind: "page.create";
      name: string;
      journalDay: number | null;
      properties?: Properties;
      createdAt: number;
    }
  | { kind: "page.rename"; name: string }
  | { kind: "page.prop"; key: string; value: string | null }
  | { kind: "page.delete"; deletedAt: number | null }
  | {
      kind: "block.create";
      place: BlockPlace;
      content: string;
      marker?: TaskMarker | null;
      priority?: Priority | null;
      collapsed?: boolean;
      properties?: Properties;
      createdAt: number;
    }
  | { kind: "block.place"; place: BlockPlace }
  | { kind: "block.text"; content: string }
  | { kind: "block.prop"; key: string; value: string | null }
  | { kind: "block.delete"; deletedAt: number | null };

export type OpKind = OpPayload["kind"];

export interface Op {
  /** Equals hlc: globally unique and time-ordered. */
  id: string;
  hlc: string;
  device: string;
  /** Page id for page.* ops, block id for block.* ops. */
  entity: string;
  payload: OpPayload;
}

/** An op accepted by the server, with its position in the server log. */
export interface LoggedOp extends Op {
  seq: number;
  status: "applied" | "noop" | "rejected";
}

export const RESERVED_BLOCK_PROPS = new Set(["marker", "priority", "collapsed", "id"]);

export function isOp(x: unknown): x is Op {
  if (typeof x !== "object" || x === null) return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    typeof o.hlc === "string" &&
    isHlc(o.hlc) &&
    o.id === o.hlc &&
    typeof o.device === "string" &&
    typeof o.entity === "string" &&
    isUuid(o.entity) &&
    typeof o.payload === "object" &&
    o.payload !== null &&
    typeof (o.payload as { kind?: unknown }).kind === "string"
  );
}

/** Build an op; the caller supplies the clock. */
export function makeOp(hlc: string, device: string, entity: string, payload: OpPayload): Op {
  return { id: hlc, hlc, device, entity, payload };
}
