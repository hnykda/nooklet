---
title: Connect an agent
description: Give Claude Code or any MCP client a scoped token so it can read and edit your graph.
order: 3
---

> Placeholder page. The real guide lives in `docs/guide/` at the repository root.

nooklet exposes the operations the app itself uses as an HTTP API, an OpenAPI document, and an
MCP server. Nothing is on until you create a token.

## Create a token

```sh
nooklet token create --label claude --scope write
```

Scopes are `read`, `write` and `admin`. You can revoke a token at any time.

## Point your client at it

```json
{
  "mcpServers": {
    "nooklet": {
      "type": "http",
      "url": "http://127.0.0.1:6100/mcp",
      "headers": { "Authorization": "Bearer nk_..." }
    }
  }
}
```

## What an agent can do

- Orient itself with `graph_overview`.
- Search by keyword, by meaning, or both.
- Edit an exact substring inside one bullet instead of rewriting the page.
- Run several edits as one batch, and undo that batch.

An agent can also read and drive the window you have open, but only after you switch that on in
the window and mint a token with `--ui-control`.
