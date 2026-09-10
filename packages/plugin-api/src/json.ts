/**
 * Wire-safe JSON value (`docs/spec/api-and-plugin-types.md` §1.1). Every value that crosses a
 * plugin/host boundary (command args, RPC args/results, kv values, MCP tool content, `beforeWrite`
 * payloads reachable from plugin code) is constrained to this type so the API is sandbox-ready:
 * nothing that isn't structured-clone/JSON-serializable ever needs to cross a future worker or
 * iframe boundary (ADR 007).
 */
export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
