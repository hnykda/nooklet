/**
 * Build-time only: turns `emojibase-data`'s English `data.json` (775 KB, every skin-tone variant,
 * hexcodes, emoticons, subgroups) into the ~130 KB the picker actually reads, served as the
 * `virtual:emoji-data` module. The picker imports that module lazily, so it is its own chunk and
 * never part of the main bundle (B-647; sizes in `docs/progress/icon-picker.md`).
 *
 * Why trim at build time rather than import `emojibase-data/en/compact.json` directly: compact.json
 * is 571 KB / 83 KB gzipped because it still carries every skin-tone variant, which the picker does
 * not offer ("nothing fancy"). The dependency stays the single source; nothing generated is
 * committed.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { Plugin } from "vite";
import type { EmojiData, EmojiRow } from "./types.js";

/** emojibase's "component" group: bare skin-tone swatches and hair styles, not icons. */
const COMPONENT_GROUP = 2;

/**
 * The newest Emoji version kept. Newer glyphs render as an empty box on any OS that has not caught
 * up yet (Emoji 16 needs iOS 18.4 / macOS 15.4; older Windows and Linux fonts lag further), and a
 * page icon that is a box is worse than a slightly shorter list. 15.1 drops 16 glyphs.
 */
export const MAX_EMOJI_VERSION = 15.1;

interface RawEmoji {
  emoji: string;
  label: string;
  tags?: string[];
  group?: number;
  order?: number;
  version: number;
}

interface RawMessages {
  groups: { key: string; message: string; order: number }[];
}

export function buildEmojiData(raw: readonly RawEmoji[], messages: RawMessages): EmojiData {
  // The groups keep their emojibase indices (rows point at them), so the component group stays in
  // the list as a name nobody is shown.
  const groups: string[] = [];
  for (const g of messages.groups) groups[g.order] = g.message;
  const emojis: EmojiRow[] = raw
    // No group = regional indicator letters, which only mean something in pairs (flags).
    .filter(
      (e) => e.group !== undefined && e.group !== COMPONENT_GROUP && e.version <= MAX_EMOJI_VERSION,
    )
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map((e) => [e.emoji, e.label, (e.tags ?? []).join(" "), e.group as number] as const);
  return { groups, emojis };
}

const ID = "virtual:emoji-data";
// The `\0` prefix is Rollup's convention for "not a file": other plugins leave it alone.
const RESOLVED = `\0${ID}`;

export function emojiDataPlugin(): Plugin {
  return {
    name: "nooklet:emoji-data",
    resolveId(id) {
      return id === ID ? RESOLVED : undefined;
    },
    load(id) {
      if (id !== RESOLVED) return undefined;
      const require = createRequire(import.meta.url);
      const read = (path: string): unknown =>
        JSON.parse(readFileSync(require.resolve(path), "utf8"));
      const data = buildEmojiData(
        read("emojibase-data/en/data.json") as RawEmoji[],
        read("emojibase-data/en/messages.json") as RawMessages,
      );
      // `JSON.parse` of a string literal, not an object literal: engines parse JSON faster than
      // the equivalent JS (v8.dev/blog/cost-of-javascript-2019#json).
      return `export default JSON.parse(${JSON.stringify(JSON.stringify(data))});`;
    },
  };
}
