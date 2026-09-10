# ADR 008: One operation registry for HTTP, MCP, and the typed client

Date: 2026-09-10. Status: accepted.

## Decision

- Stack: Hono 4 in one process (web client, `/api/v1`, `/mcp`, `/openapi.json`, `/sync`,
  `/assets`), Zod 4 schemas with generated JSON Schema, MCP SDK v2
  (`@modelcontextprotocol/server` + `@modelcontextprotocol/hono`, spec 2026-07-28) as a
  stateless Streamable HTTP server with bearer auth, plus a `nooklet mcp --stdio` bridge.
- `defineOp({ name, summary, description, input, output, annotations, scopes, expose, render,
  handler })` is the single definition. Loops mount `POST /api/v1/<name>` (with REST-style
  aliases where natural), build OpenAPI, register MCP tools (text content from `render`,
  structured content validated against the output schema, errors with hints), and derive a typed
  client. Plugins register ops through the same registry; plugin ops default to HTTP-only.
- v1 exposes 18 MCP tools (ADR 013 adds `batch_undo` and `asset_upload` to the original 16) with
  annotations and a token budget for `tools/list`; read tools are marked always-loaded for
  clients that defer tools behind tool search. Writes accept markdown and return created
  outlines with ids; `block_update` supports string replacement within a block and `if_version`;
  `batch` is atomic with `dry_run` and idempotency keys.
- Outline serialization: our mirror format with ` ^id` suffixes; `ids: none`, depth and size
  limits for cheap reads; JSON on request.
- Safety: scoped tokens (`read` default, `write`, `admin`) with labels as audit actors, soft
  delete to trash, rate limits, and a `changes` table written in the same transaction as the ops
  for `changes_since`, UI attribution, and agent-batch undo.

## Why

- Evidence from the user's current Logseq MCP server: unpaginated 1,274-page listings, page
  reads that time out, no block ids in text mode, one-block-per-call inserts, full-page replace
  that destroys ids, duplicated pages after retries. Every one of those is a design error we can
  avoid by defining operations once with pagination, ids, tree inserts, and idempotency.
- OpenAPI-to-MCP generators produce one tool per endpoint and sprawl; oRPC has no MCP adapter;
  Effect is too heavy. A 200-line registry gives one source of truth.
