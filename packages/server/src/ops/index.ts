/**
 * The v1 operation registry: 32 core ops from `docs/spec/mcp-tools.md` §4, registered once
 * (16 from the original v1 list, `batch.undo`/`asset.upload` added by ADR 013's M1.5 scope,
 * `related.find` added by M3/ADR 010's embeddings work, the five `ui.*` ops added by ADR 015's
 * live-UI-control channel, `system.diagnostics` for backend health, `graph.links` for the
 * graph view — `ref` is server-only, so only the server can answer "what links to what" — the
 * three `embeddings.*` ops that let the settings panel turn semantic search on without a terminal,
 * and the M7/ADR 022 trio `trash.list`/`trash.restore`/`page.history` over the audit log).
 *
 * Not all of them are MCP tools: the `ui.*` ops need the `ui:control` capability, and the three
 * `embeddings.*` ops are HTTP-only by design (see `./embeddings.ts`'s header). `../mcp/server.test.ts`
 * pins the resulting tool list.
 */

// ADR 015: live-UI-control ops, kept in `../live/` (tightly coupled to the window registry/RPC
// there) and registered into CORE_OPS here, same as every other op.
import { uiHighlight, uiNavigate, uiRun, uiState, uiWindows } from "../live/index.js";
import { assetInfoOp, assetUpload } from "./asset-upload.js";
import { batch } from "./batch.js";
import { batchUndo } from "./batch-undo.js";
import { blockDelete } from "./block-delete.js";
import { blockInsert } from "./block-insert.js";
import { blockMove } from "./block-move.js";
import { blockMoveToPage } from "./block-move-to-page.js";
import { blockRead } from "./block-read.js";
import { blockToPage } from "./block-to-page.js";
import { blockUpdate } from "./block-update.js";
import { changesSince } from "./changes-since.js";
import { systemDiagnostics } from "./diagnostics.js";
import { embeddingsConfigure, embeddingsReindex, embeddingsStatus } from "./embeddings.js";
import { graphLinks } from "./graph-links.js";
import { graphOverview } from "./graph-overview.js";
import { graphReplace } from "./graph-replace.js";
import { IMPORT_OPS } from "./import.js";
import { pageAppend } from "./page-append.js";
import { pageBacklinks } from "./page-backlinks.js";
import { pageCreate } from "./page-create.js";
import { pageDelete } from "./page-delete.js";
import { pageHistory } from "./page-history.js";
import { pageLinkUnlinked } from "./page-link-unlinked.js";
import { pageList } from "./page-list.js";
import { pageMerge } from "./page-merge.js";
import { pageRead } from "./page-read.js";
import { pageUpdate } from "./page-update.js";
import { pairingCreate, pairingRedeem, tokenList, tokenRevoke } from "./pairing.js";
import { OpRegistry } from "./registry.js";
import { relatedFind } from "./related.js";
import { search } from "./search.js";
import { trashList } from "./trash-list.js";
import { trashRestore } from "./trash-restore.js";

export const CORE_OPS = [
  graphOverview,
  systemDiagnostics,
  embeddingsStatus,
  embeddingsConfigure,
  embeddingsReindex,
  pageList,
  pageRead,
  blockRead,
  search,
  relatedFind,
  pageBacklinks,
  pageLinkUnlinked,
  graphLinks,
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
  // B-737 (was B-703's asset.sizes): keyed URLs and picture sizes, for the renderer and agents.
  assetInfoOp,
  trashList,
  trashRestore,
  pageHistory,
  // M7 (research/13 §4.2 items 3-4): block/page refactors and graph-wide find & replace.
  blockToPage,
  blockMoveToPage,
  pageMerge,
  graphReplace,
  uiWindows,
  uiState,
  uiRun,
  uiNavigate,
  uiHighlight,
  // B-655: device management under `admin`, and QR pairing (`./pairing.ts`).
  pairingCreate,
  pairingRedeem,
  tokenList,
  tokenRevoke,
  // ADR 031: import a Logseq graph from the app (`admin`, HTTP only).
  ...IMPORT_OPS,
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
  blockMoveToPage,
  blockRead,
  blockToPage,
  blockUpdate,
  changesSince,
  embeddingsConfigure,
  embeddingsReindex,
  embeddingsStatus,
  graphLinks,
  graphOverview,
  graphReplace,
  pageAppend,
  pageBacklinks,
  pageCreate,
  pageDelete,
  pageHistory,
  pageLinkUnlinked,
  pageList,
  pageMerge,
  pageRead,
  pageUpdate,
  relatedFind,
  search,
  trashList,
  trashRestore,
  uiHighlight,
  uiNavigate,
  uiRun,
  uiState,
  uiWindows,
};
