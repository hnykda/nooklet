/**
 * The launcher's wording for every server state (B-430), against the same examples the Rust side
 * serializes to (`server-status.json`). Run with `node --test` (`pnpm --filter @nooklet/desktop test`).
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { describeStatus } from "../launcher/status.js";

const fixtures = JSON.parse(readFileSync(new URL("./server-status.json", import.meta.url), "utf8"));
const view = (name) => {
  assert.ok(name in fixtures, `no fixture ${name}`);
  return describeStatus(fixtures[name]);
};
const words = (v) => `${v.title} ${v.message}`;

test("a graph from a newer nooklet says to update the app, with the server's own words", () => {
  const v = view("schema_too_new");
  assert.equal(v.kind, "problem");
  assert.match(words(v), /Update the app/);
  assert.equal(v.suggestServe, false);
  assert.doesNotMatch(words(v), /nooklet serve|start it/i);
  assert.equal(
    v.detail,
    "nooklet: database schema version 6 is newer than this build supports (4); upgrade nooklet",
  );
});

test("only when nothing was spawned does the page suggest starting a server", () => {
  for (const name of Object.keys(fixtures).filter((k) => !k.startsWith("_"))) {
    const expected = name === "external";
    assert.equal(view(name).suggestServe, expected, name);
  }
  // No app to ask (the page opened outside it): nothing was spawned either.
  assert.equal(describeStatus(null).suggestServe, true);
  assert.equal(describeStatus(undefined).kind, "no-server");
});

test("every exit and failure names what happened and carries its output", () => {
  const port = view("port_in_use");
  assert.match(words(port), /port 6100/);
  assert.match(port.detail, /EADDRINUSE/);

  const other = view("exited_other");
  assert.match(other.message, /exited with code 1/);
  assert.match(other.message, /last output is below/);
  assert.match(other.detail, /SQLITE_CANTOPEN/);

  const killed = view("killed");
  assert.match(killed.message, /was stopped/);
  assert.doesNotMatch(killed.message, /output is below/);
  assert.equal(killed.detail, undefined);

  const spawn = view("spawn_failed");
  assert.match(words(spawn), /Reinstall/);
  assert.match(spawn.detail, /os error 2/);

  const slow = view("timed_out");
  assert.equal(slow.kind, "problem");
  assert.equal(slow.detail, "nooklet: importing plugins…");
});

test("a server that is starting, or has just answered, shows as starting", () => {
  assert.equal(view("starting").kind, "starting");
  assert.equal(view("ready").kind, "starting");
  assert.equal(view("starting").suggestServe, false);
});
