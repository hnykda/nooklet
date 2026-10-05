/**
 * `edit.paste` (`docs/spec/commands-and-keymap.md` R33). Three pure-ish cases:
 *  1. Plain text with no `\n` — not handled here at all; the caller lets CodeMirror insert it as
 *     ordinary text (no new block, no ops).
 *  2. Plain text containing `\n` — parsed with `@nooklet/core`'s `parseOutline` (leading-
 *     whitespace/list-marker depth, fenced code as one block, blank-line-separated paragraphs as
 *     separate blocks) and inserted as sibling blocks after the current one; if the current block
 *     was empty (and childless), the first pasted block replaces it instead of being inserted
 *     after. Pure and DOM-free (`paste.test.ts`).
 *  3. An image in the clipboard — uploaded via the server's `asset.upload` endpoint and
 *     `![](<asset-url>)` inserted at the caret. This one is NOT pure (it's a `fetch` call); it
 *     lives in `uploadImageAsset` below, kept tiny and isolated so the tree-building logic above
 *     stays testable without a network mock.
 */

import {
  makeOp,
  newId,
  type Op,
  type OutlineNode,
  ordersBetween,
  type ParsedPage,
  parseOutline,
} from "@nooklet/core";
import { callOp } from "../data/api-client.js";
import { rememberAsset } from "../data/asset-info.js";
import { getBlock, nextSiblingOrder } from "./tree.js";
import type { BlockId, CaretSpec, Clock, EditorTree } from "./types.js";

export interface PasteTreeResult {
  ops: Op[];
  focus: { id: BlockId; caret: CaretSpec };
}

/** R33 case 2. `text` MUST contain at least one `\n` (case 1 is the caller's job, not this
 * function's — see file header).
 *
 * Pasted into the zoom root (`zoomRootId === targetId`, B-788), the blocks go in as its first
 * children, where Enter on it puts a new block: as siblings they were outside the zoomed view and
 * never showed. Nor does an empty root get replaced — deleting it would empty the whole view. */
export function pasteMarkdownAsTree(
  tree: EditorTree,
  targetId: BlockId,
  text: string,
  clock: Clock,
  now: number = Date.now(),
  scope: { zoomRootId?: BlockId | null } = {},
): PasteTreeResult {
  const parsed = { blocks: pastedBlocks(parseOutline(text)) };
  const target = getBlock(tree, targetId);
  const kids = tree.childrenOf.get(targetId) ?? [];
  const intoRoot = scope.zoomRootId != null && scope.zoomRootId === targetId;
  const targetIsEmpty = !intoRoot && target.content === "" && kids.length === 0;

  const parentId = intoRoot ? targetId : target.parentId;
  const firstKid = kids[0];
  const lowerBound = intoRoot
    ? null
    : targetIsEmpty
      ? previousSiblingOrder(tree, target.parentId, targetId)
      : target.order;
  const upperBound = intoRoot
    ? firstKid
      ? getBlock(tree, firstKid).order
      : null
    : nextSiblingOrder(tree, target.parentId, targetId);

  const topOrders = ordersBetween(lowerBound, upperBound, parsed.blocks.length);
  const ops: Op[] = [];
  let lastTopId = "";
  let lastTopContentLength = 0;

  const walk = (node: OutlineNode, newParentId: BlockId | null, order: string): string => {
    const nid = newId(now);
    ops.push(
      makeOp(clock.next(), clock.device, nid, {
        kind: "block.create",
        place: { pageId: tree.pageId, parentId: newParentId, order },
        content: node.content,
        marker: node.marker,
        priority: node.priority,
        collapsed: node.collapsed,
        properties: node.properties,
        createdAt: now,
      }),
    );
    const childOrders = ordersBetween(null, null, node.children.length);
    node.children.forEach((c, i) => {
      walk(c, nid, childOrders[i] as string);
    });
    return nid;
  };

  parsed.blocks.forEach((node, i) => {
    const nid = walk(node, parentId, topOrders[i] as string);
    if (i === parsed.blocks.length - 1) {
      lastTopId = nid;
      lastTopContentLength = node.content.length;
    }
  });

  if (targetIsEmpty) {
    ops.push(
      makeOp(clock.next(), clock.device, targetId, { kind: "block.delete", deletedAt: now }),
    );
  }

  return { ops, focus: { id: lastTopId, caret: { offset: lastTopContentLength } } };
}

/**
 * The blocks a paste creates. To the parser, property lines before the first bullet — or a first
 * bullet holding nothing but property lines (`- type:: book`) — are a page's properties (OUT-2),
 * and a paste has no page to give them to: only `.blocks` was inserted, so those lines vanished
 * without a word (B-311, the same silent drop B-235 was on the server). They become a block of
 * their own instead, an empty one carrying them as its properties, first — which is also what
 * copying such a block writes back out. Not `id`: the pre-block's `id::` is a page's id (OUT-15),
 * and a paste mints new ids for everything it creates anyway.
 */
function pastedBlocks(parsed: ParsedPage): OutlineNode[] {
  const { id: _pageId, ...properties } = parsed.properties;
  if (Object.keys(properties).length === 0) return parsed.blocks;
  const preBlock: OutlineNode = {
    content: "",
    marker: null,
    priority: null,
    properties,
    collapsed: false,
    children: [],
  };
  return [preBlock, ...parsed.blocks];
}

function previousSiblingOrder(
  tree: EditorTree,
  parentId: BlockId | null,
  id: BlockId,
): string | null {
  const siblings = tree.childrenOf.get(parentId) ?? [];
  const idx = siblings.indexOf(id);
  const prev = siblings[idx - 1];
  return prev ? getBlock(tree, prev).order : null;
}

// -------------------------------------------------------------------------------------------
// R33 case 3 — image paste
// -------------------------------------------------------------------------------------------

export interface AssetUploadResponse {
  id: string;
  url: string;
  markdown: string;
  mimeType: string;
  byteSize: number;
  deduped: boolean;
}

/** Uploads one image file via `POST /api/v1/asset.upload` (`docs/spec/mcp-tools.md` §4.3.18) and
 * returns the ready-to-paste markdown. Used by image paste and by `/image`. Throws (`ApiError`) on
 * any failure; the caller (per R33) must not apply the insertion.
 *
 * Through `callOp`, which carries this device's token. This used to be a bare `fetch` with no
 * `authorization` header — and every `/api/v1/*` route is behind `bearerAuth`, so in the served app
 * every image paste got a 401 and was dropped with only a console line to show for it (B-150). */
export async function uploadImageAsset(file: File): Promise<AssetUploadResponse> {
  const dataBase64 = await fileToBase64(file);
  const json = await callOp<{
    id: string;
    url: string;
    markdown: string;
    mime_type: string;
    byte_size: number;
    deduped: boolean;
    key: string;
    width: number | null;
    height: number | null;
  }>("asset.upload", {
    filename: file.name || "pasted-image",
    mime_type: file.type || "application/octet-stream",
    data_base64: dataBase64,
  });
  // The answer carries the asset's URL key (B-737): remember it, so the picture this paste is about
  // to insert renders without another round trip to learn it.
  rememberAsset(json.id, json.key, json.width, json.height);
  return {
    id: json.id,
    url: json.url,
    markdown: json.markdown,
    mimeType: json.mime_type,
    byteSize: json.byte_size,
    deduped: json.deduped,
  };
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("failed to read pasted file"));
    reader.onload = () => {
      const result = reader.result as string; // "data:<mime>;base64,<data>"
      const comma = result.indexOf(",");
      resolve(comma === -1 ? result : result.slice(comma + 1));
    };
    reader.readAsDataURL(file);
  });
}
