/**
 * `graph.links` — the page-to-page link graph: one node per page, one edge per "page A's blocks
 * reference page B".
 *
 * An agent can use it to ask what the graph is *shaped* like ("which pages are hubs?") rather
 * than what it says, which is what `search` is for. The reading itself is in `@nooklet/core`
 * (`sync/link-graph.ts`): since B-641 a client replica keeps the reference index too and answers
 * its graph view from the device with the same code.
 *
 * Journals are excluded by default, and that is a bigger filter than it looks: in a daily-notes
 * graph most links are *written* in journal entries, so dropping journal nodes also drops every
 * reference whose source block lives on one. Excluding them leaves the page-to-page skeleton,
 * which is the useful picture; including them gives you the full thing plus several hundred
 * date nodes. `note` says which of the two you got.
 */

import { linkGraph } from "@nooklet/core";
import { z } from "zod";
import { defineOp } from "./registry.js";

/** Nodes returned at most. Not `schemas.ts`'s shared `Limit` (max 500): a graph is useless cut to
 * 500 pages, and the caller is a renderer, not a paginating reader — there is no cursor here. */
const NodeLimit = z
  .number()
  .int()
  .min(1)
  .max(5000)
  .default(1500)
  .describe("Max nodes (default 1500, max 5000); the most-connected pages are kept");

export const graphLinks = defineOp({
  name: "graph.links",
  summary: "Page-to-page link graph (nodes and edges)",
  description:
    "Returns the whole graph as nodes (pages) and edges (references between them), for drawing a " +
    "graph view or for finding hubs and clusters. An edge from A to B means some block on page A " +
    "references page B via [[link]], #tag, or a block ref. Journals are excluded unless " +
    "include_journals is true - note that this also drops references written in journal entries, " +
    "which in a daily-notes graph is most of them. Capped at limit nodes, keeping the " +
    "most-connected ones; truncated and note say what was left out. This is structure only: it " +
    "returns no block text, so use page_backlinks to see what a link actually says.",
  input: z
    .object({
      include_journals: z
        .boolean()
        .default(false)
        .describe("Include journal pages, and the references written in them"),
      limit: NodeLimit,
    })
    .strict(),
  output: z.object({
    nodes: z.array(
      z.object({
        id: z.string().describe("Page id"),
        name: z.string().describe("Page name; a journal's ISO date, per rule 18"),
        is_journal: z.boolean(),
        ref_count: z
          .number()
          .int()
          .describe("References touching this page, incoming plus outgoing, before any cap"),
      }),
    ),
    edges: z.array(
      z.object({
        from: z.string().describe("Page id the reference was written on"),
        to: z.string().describe("Page id it points at"),
        count: z.number().int().describe("How many references, so an edge can be weighted"),
      }),
    ),
    total_nodes: z.number().int().describe("Pages that matched before limit was applied"),
    total_edges: z.number().int(),
    truncated: z.boolean(),
    note: z
      .string()
      .optional()
      .describe("Present when something was left out of nodes/edges; says what and why"),
  }),
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  scopes: ["read"],
  render: (out) =>
    `${out.nodes.length} page(s), ${out.edges.length} link(s)` +
    (out.truncated ? ` (truncated from ${out.total_nodes})` : "") +
    (out.note ? ` - ${out.note}` : ""),
  // `@nooklet/core`'s `linkGraph`: the same reading a client replica draws its graph view with
  // (B-641), so the device and the server draw the same graph.
  handler: async (input, ctx) =>
    linkGraph(ctx.db, { includeJournals: input.include_journals, limit: input.limit }),
});
