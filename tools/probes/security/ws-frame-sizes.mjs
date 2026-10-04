#!/usr/bin/env node
// How large is the largest frame a legitimate client sends to /sync/live or /ui/live? Sizes the
// server's `maxPayload` (B-676 H4/H12, docs/progress/ws-hardening.md).
//
// Usage: node tools/probes/security/ws-frame-sizes.mjs
//
// Client -> server frames, from the client code (2026-10-04):
//   /sync/live  only {type:"hello", device_id, token}          (apps/web/src/sync/http-transport.ts)
//   /ui/live    hello (+ page {id,name})                        (apps/web/src/live/socket.ts)
//               state.result {state: UiWindowStateWire}         (apps/web/src/live/message-handler.ts)
//               command.result {when_result} or {error <=1000 chars}
// Server -> client frames (pokes, state.get, command.run) are not limited by `maxPayload`, which
// only bounds what the server receives.
//
// The only frame that grows with the data is state.result: `focus.selected_block_ids` lists every
// selected block (a select-all on a page selects all of them). Everything else is a few hundred
// bytes. Ids are 14 chars (packages/core/src/ids.ts).

const id = (i) => i.toString(32).padStart(14, "0");
const bytes = (o) => Buffer.byteLength(JSON.stringify(o), "utf8");
const token = `nk_${"x".repeat(32)}`; // leak-check: allow (a placeholder, not a token)

// A long page name with multi-byte characters, 300 characters.
const longName = "Plánování zahradních úprav / ".repeat(10);

const syncHello = { type: "hello", device_id: id(1), token };
const uiHello = {
  type: "hello",
  device_id: id(1),
  window_id: crypto.randomUUID(),
  token,
  client: "web",
  control_enabled: true,
  page: { id: id(2), name: longName },
  focused: true,
};
const commandError = {
  type: "command.result",
  request_id: crypto.randomUUID(),
  error: "é".repeat(1000),
};
const stateResult = (n) => ({
  type: "state.result",
  request_id: crypto.randomUUID(),
  state: {
    window_id: crypto.randomUUID(),
    device_id: id(1),
    focused: true,
    page: { id: id(2), name: longName, kind: "page" },
    zoom_root_block_id: id(3),
    focus: {
      mode: "block_selection",
      block_id: id(4),
      selected_block_ids: Array.from({ length: n }, (_, i) => id(i + 10)),
      cursor: null,
    },
    viewport: { first_visible_block_id: id(5), last_visible_block_id: id(6), scroll_top: 123456 },
    panels: { sidebar_open: true, active_view: "page", dialog_open: "command-palette" },
    updated_at: new Date().toISOString(),
  },
});

console.log(`sync hello                      ${bytes(syncHello)} B`);
console.log(`ui hello (300-char page name)   ${bytes(uiHello)} B`);
console.log(`command.result, 1000-char error ${bytes(commandError)} B`);
for (const n of [0, 200, 1000, 5000, 10000, 20000, 30000]) {
  console.log(`state.result, ${String(n).padStart(5)} selected     ${bytes(stateResult(n))} B`);
}
const perId = (bytes(stateResult(10000)) - bytes(stateResult(0))) / 10000;
console.log(`per selected id: ${perId} B`);
for (const limit of [64 * 1024, 256 * 1024, 512 * 1024]) {
  const fits = Math.floor((limit - bytes(stateResult(0))) / perId);
  console.log(`${limit / 1024} KiB fits ${fits} selected ids`);
}
