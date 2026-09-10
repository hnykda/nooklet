/**
 * Core data model of a vrite graph.
 *
 * A graph is a set of pages; each page owns an ordered tree of blocks.
 * Blocks carry markdown text. References ([[page]], #tag, ((block)))
 * are *derived* from block content, never stored as source of truth.
 */

export type BlockId = string; // UUID v4 (Logseq-compatible for ((refs)) and id:: properties)
export type PageId = string; // UUID v4

/** Task markers. Both Logseq workflows are supported (TODO/DOING and LATER/NOW). */
export const TASK_MARKERS = [
  "TODO",
  "DOING",
  "LATER",
  "NOW",
  "WAITING",
  "DONE",
  "CANCELED",
] as const;
export type TaskMarker = (typeof TASK_MARKERS)[number];

export type Priority = "A" | "B" | "C";

/** Raw `key:: value` properties. Values are kept as strings; refs inside them are derived. */
export type Properties = Record<string, string>;

export interface Block {
  id: BlockId;
  pageId: PageId;
  /** null = top-level block of the page */
  parentId: BlockId | null;
  /** Fractional index; sorts lexicographically among siblings. Sync-friendly (per-block attribute). */
  order: string;
  /** Markdown text without bullet, marker, priority and property lines. May be multi-line. */
  content: string;
  marker: TaskMarker | null;
  priority: Priority | null;
  properties: Properties;
  collapsed: boolean;
  createdAt: number; // epoch ms
  updatedAt: number; // epoch ms
}

export interface Page {
  id: PageId;
  /** Display name with original casing, e.g. "Projects/Vrite". Namespaces are "/"-separated. */
  name: string;
  /** Identity key: normalizePageName(name). Unique per graph. */
  key: string;
  /** YYYYMMDD for journal pages, else null. */
  journalDay: number | null;
  properties: Properties;
  createdAt: number;
  updatedAt: number;
}

/** Tree node produced by the outline parser (file/markdown text -> tree). */
export interface OutlineNode {
  /** From an `id::` property when present. */
  id?: string;
  content: string;
  marker: TaskMarker | null;
  priority: Priority | null;
  properties: Properties;
  collapsed: boolean;
  children: OutlineNode[];
}

export interface ParsedPage {
  properties: Properties;
  blocks: OutlineNode[];
}
