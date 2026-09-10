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
  ordersBetween,
  type OutlineNode,
  parseOutline,
} from "@nooklet/core";
import { getBlock, nextSiblingOrder } from "./tree.js";
import type { BlockId, CaretSpec, Clock, EditorTree } from "./types.js";

export interface PasteTreeResult {
  ops: Op[];
  focus: { id: BlockId; caret: CaretSpec };
}

/** R33 case 2. `text` MUST contain at least one `\n` (case 1 is the caller's job, not this
 * function's — see file header). */
export function pasteMarkdownAsTree(
  tree: EditorTree,
  targetId: BlockId,
  text: string,
  clock: Clock,
  now: number = Date.now(),
): PasteTreeResult {
  const parsed = parseOutline(text);
  const target = getBlock(tree, targetId);
  const targetIsEmpty = target.content === "" && (tree.childrenOf.get(targetId)?.length ?? 0) === 0;

  const parentId = target.parentId;
  const lowerBound = targetIsEmpty
    ? previousSiblingOrder(tree, target.parentId, targetId)
    : target.order;
  const upperBound = nextSiblingOrder(tree, target.parentId, targetId);

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
    node.children.forEach((c, i) => walk(c, nid, childOrders[i] as string));
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
    ops.push(makeOp(clock.next(), clock.device, targetId, { kind: "block.delete", deletedAt: now }));
  }

  return { ops, focus: { id: lastTopId, caret: { offset: lastTopContentLength } } };
}

function previousSiblingOrder(tree: EditorTree, parentId: BlockId | null, id: BlockId): string | null {
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

/** Uploads one clipboard image file via `POST /api/v1/asset.upload` (`docs/spec/mcp-tools.md`
 * §4.3.18) and returns the ready-to-paste markdown. Throws on any non-2xx response; the caller
 * (per R33) must not apply the paste and must surface an error notification instead. */
export async function uploadImageAsset(
  file: File,
  apiBase = "",
): Promise<AssetUploadResponse> {
  const dataBase64 = await fileToBase64(file);
  const res = await fetch(`${apiBase}/api/v1/asset.upload`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      filename: file.name || "pasted-image",
      mime_type: file.type || "application/octet-stream",
      data_base64: dataBase64,
    }),
  });
  if (!res.ok) throw new Error(`asset upload failed: ${res.status} ${res.statusText}`);
  const json = (await res.json()) as {
    id: string;
    url: string;
    markdown: string;
    mime_type: string;
    byte_size: number;
    deduped: boolean;
  };
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
