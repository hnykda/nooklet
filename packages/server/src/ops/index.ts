/**
 * The v1 operation registry: 24 core ops from `docs/spec/mcp-tools.md` §4, registered once
 * (16 from the original v1 list, `batch.undo`/`asset.upload` added by ADR 013's M1.5 scope,
 * `related.find` added by M3/ADR 010's embeddings work, and the five `ui.*` ops added by ADR 015's
 * live-UI-control channel).
 */

// ADR 015: live-UI-control ops, kept in `../live/` (tightly coupled to the window registry/RPC
// there) and registered into CORE_OPS here, same as every other op.
import { uiHighlight, uiNavigate, uiRun, uiState, uiWindows } from "../live/index.js";
import { assetUpload } from "./asset-upload.js";
import { batch } from "./batch.js";
import { batchUndo } from "./batch-undo.js";
import { blockDelete } from "./block-delete.js";
import { blockInsert } from "./block-insert.js";
import { blockMove } from "./block-move.js";
import { blockRead } from "./block-read.js";
import { blockUpdate } from "./block-update.js";
import { changesSince } from "./changes-since.js";
import { graphOverview } from "./graph-overview.js";
import { pageAppend } from "./page-append.js";
import { pageBacklinks } from "./page-backlinks.js";
import { pageCreate } from "./page-create.js";
import { pageDelete } from "./page-delete.js";
import { pageList } from "./page-list.js";
import { pageRead } from "./page-read.js";
import { pageUpdate } from "./page-update.js";
import { OpRegistry } from "./registry.js";
import { relatedFind } from "./related.js";
import { search } from "./search.js";

export const CORE_OPS = [
  graphOverview,
  pageList,
  pageRead,
  blockRead,
  search,
  relatedFind,
  pageBacklinks,
  changesSince,
  pageCreate,
  pageAppend,
  blockInsert,
  blockUpdate,
  blockMove,
  blockDelete,
  pageUpdate,
  batch,
  pageDelete,
  batchUndo,
  assetUpload,
  uiWindows,
  uiState,
  uiRun,
  uiNavigate,
  uiHighlight,
];

export function buildRegistry(): OpRegistry {
  const reg = new OpRegistry();
  for (const op of CORE_OPS) reg.register(op, "core");
  return reg;
}

export * from "./registry.js";
export {
  assetUpload,
  batch,
  batchUndo,
  blockDelete,
  blockInsert,
  blockMove,
  blockRead,
  blockUpdate,
  changesSince,
  graphOverview,
  pageAppend,
  pageBacklinks,
  pageCreate,
  pageDelete,
  pageList,
  pageRead,
  pageUpdate,
  relatedFind,
  search,
  uiHighlight,
  uiNavigate,
  uiRun,
  uiState,
  uiWindows,
};
