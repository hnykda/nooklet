/**
 * The emoji list the page-icon picker searches (B-647), as the `virtual:emoji-data` module hands
 * it over. Tuples, not objects: ~1,900 rows, and the keys would be a third of the chunk.
 */

/** `[emoji, English name, space-separated keywords, group index]`. */
export type EmojiRow = readonly [emoji: string, label: string, tags: string, group: number];

export interface EmojiData {
  /** Group display names, indexed by `EmojiRow[3]` ("smileys & emotion", …). */
  readonly groups: readonly string[];
  /** In Unicode's own order, which is also the order within each group. */
  readonly emojis: readonly EmojiRow[];
}
