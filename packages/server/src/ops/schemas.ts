/**
 * Shared Zod schemas for the v1 operation registry (`docs/spec/mcp-tools.md` §4.1). Every field
 * here is wire-facing (`snake_case`, per `00-conventions.md`'s API conventions rule) and carries a
 * `.describe()` per mcp-tools.md rule 3.1.5. `zod` is v4.6.1; `z.record(keySchema, valueSchema)`
 * (two-arg form) and `z.toJSONSchema` are both v4 APIs, confirmed against the installed
 * `node_modules/.pnpm/zod@4.6.1` type declarations.
 */

import { z } from "zod";

export const BlockId = z
  .string()
  .regex(/^[0-9a-hjkmnp-tv-z]{14}$/)
  .describe("14-char block id, e.g. 1k7f3q9xz2hav4 (shown as ^1k7f3q9xz2hav4 in Markdown)");

export const PageRef = z
  .string()
  .min(1)
  .max(512)
  .describe(
    'Page name (case-insensitive; namespaces use "/", e.g. "Projects/Aurora"), a page ' +
      'or block id, a journal date "YYYY-MM-DD", or "today" | "yesterday" | "tomorrow"',
  );

export const Cursor = z
  .string()
  .max(256)
  .describe("Opaque pagination cursor from a previous response; pass back unchanged");
export const Limit = z
  .number()
  .int()
  .min(1)
  .max(500)
  .default(50)
  .describe("Max items to return (default 50, max 500)");
export const IdempotencyKey = z
  .string()
  .max(128)
  .optional()
  .describe(
    "Client-chosen key; repeating a call with the same key and body returns the original result instead of applying it twice (stored 24h)",
  );

export const Version = z
  .string()
  .describe(
    "Opaque version token, currently the entity's updated_at (ISO-8601); pass back as if_version to fail the write if it changed since you read it",
  );
export const IfVersion = Version.optional().describe(
  "Only apply if the target is still at this version; on mismatch you get a conflict error with the current version",
);

export const PropertyKey = z
  .string()
  .regex(/^[a-z][a-z0-9-]*$/)
  .describe(
    'Lowercase key, hyphens not underscores (e.g. "due-date"), as nooklet normalizes property keys',
  );
export const Properties = z
  .record(PropertyKey, z.string())
  .describe(
    'key -> value as it appears in the "key:: value" line; multi-valued properties (tags, alias) are one comma-separated string',
  );
export const PropertiesPatch = z
  .record(PropertyKey, z.string().nullable())
  .describe("key -> new value, or null to remove that property");

export const OriginEnum = z
  .enum(["user", "api", "mcp", "sync", "plugin", "import", "mirror", "system"])
  .describe("How the write arrived, per 00-conventions.md");

export const Marker = z.enum(["TODO", "DOING", "LATER", "NOW", "WAITING", "DONE", "CANCELED"]);
export const PriorityLetter = z.enum(["A", "B", "C"]);

export interface BlockNodeT {
  id: string;
  content: string;
  marker?: string | null;
  priority?: string | null;
  properties?: Record<string, string>;
  collapsed?: boolean;
  children: BlockNodeT[];
  version: string;
  updated_at: string;
  updated_by?: { origin: string; actor: string };
  child_count?: number;
}

export const BlockNode: z.ZodType<BlockNodeT> = z.lazy(() =>
  z.object({
    id: BlockId,
    content: z
      .string()
      .describe(
        "Block text without bullet/marker/priority/property lines; may span lines (fences, tables, etc.)",
      ),
    marker: Marker.nullable()
      .optional()
      .describe("Task marker, or absent/null if this is not a task"),
    priority: PriorityLetter.nullable().optional(),
    properties: Properties.optional(),
    collapsed: z.boolean().optional(),
    children: z.array(BlockNode),
    version: Version,
    updated_at: z.string().describe("ISO-8601"),
    updated_by: z.object({ origin: OriginEnum, actor: z.string() }).optional(),
    child_count: z.number().int().optional().describe("Total children when they were cut by depth"),
  }),
);

export const PageMeta = z.object({
  id: z.string().describe("Page id (14-char)"),
  name: z.string(),
  kind: z.enum(["page", "journal"]),
  journal_date: z.string().optional().describe('YYYY-MM-DD, present when kind is "journal"'),
  properties: Properties.optional(),
  version: Version,
  block_count: z.number().int(),
  created_at: z.string(),
  updated_at: z.string(),
  backlink_count: z.number().int().optional(),
});

export const Position = z
  .enum(["child_first", "child_last", "before", "after"])
  .describe("Where to place relative to ref: as first/last child, or as sibling before/after");
export const Format = z
  .enum(["outline", "json"])
  .default("outline")
  .describe(
    "outline: outline Markdown with ^ids, bounded by depth/max_chars (cheapest); json: a typed block tree",
  );

export const WriteResult = z.object({
  page: z.string(),
  created: z.array(BlockId).describe("Ids of blocks created, in document order"),
  updated: z.array(BlockId).default([]),
  deleted: z.array(BlockId).default([]),
  outline: z.string().describe("Outline Markdown of the affected subtree with ^ids"),
  seq: z
    .number()
    .int()
    .describe("Highest changes-log seq written by this call; pass to changes_since"),
  dry_run: z.boolean().default(false),
});

export const MarkdownInput = z
  .string()
  .min(1)
  .max(200_000)
  .describe(
    'Markdown. Each "- " bullet (or loose paragraph) becomes a block; 2 spaces (or a tab) of extra ' +
      'indent per level nests children; "key:: value" lines under a bullet become properties; a ' +
      'fenced code block stays one block; "- [ ]"/"- [x]" become TODO/DONE; a trailing ^id on a ' +
      "bullet updates that existing block in place instead of creating a new one",
  );
