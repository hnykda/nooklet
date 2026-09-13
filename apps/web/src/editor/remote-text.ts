/**
 * B-192: telling a stale read from a newer write, for the block being edited.
 *
 * `BlockTree` refetches the page on every change, and a refetch that READ before one of this
 * tab's own writes and RESOLVED after it shows the text as it was before the write. Pushing that
 * into the editor reverted a split mid-keystroke (B-66), so the tree ignored every refetched text
 * for the edited block — and with it every real rewrite from elsewhere (another device, an agent's
 * `block.update`, "Turn into page"), which stayed stale on screen until the next keystroke wrote
 * the old text back over it.
 *
 * The database already knows which is which. A block's text is last-writer-wins on its
 * `content_hlc`: a fetched `contentHlc` NEWER than every text write this tab made to the block, and
 * newer than the text the editor was loaded with, is a write the database kept and this tab has
 * never seen. One that is not newer is either this tab's own write or a read from before it. No
 * timing is involved, so a slow worker cannot turn one into the other.
 *
 * "This tab" is the tree, not the device: a text merged by the sync client (`sync-client.ts`'s
 * three-way merge mints its op with this device's id) is still a text the editor has not shown.
 */
import type { Op } from "@nooklet/core";
import type { BlockId } from "./types.js";

/** What to do with a fetched text for the block being edited. */
export type RemoteVerdict =
  /** Not newer than what the editor holds or this tab wrote: the buffer wins (a stale read, or an
   * echo of our own write). */
  | "keep"
  /** Newer, but it says what the buffer already says: nothing to take, and a standing notice for
   * this block is moot. */
  | "same"
  /** Newer, and nothing typed is unsaved: the editor takes it. */
  | "take"
  /** Newer, but there is unsaved typing: keep the typing, offer this version. */
  | "offer"
  /** Newer, with unsaved typing, but it says what the buffer said before that typing began: the
   * other write did not change the text (an agent flipping the task marker writes a `block.text`
   * of the same content). Nothing to offer, and a standing notice for this block is moot (B-462). */
  | "untouched"
  /** Newer, unsaved typing, and this version was already offered (the notice stands, or was
   * dismissed) — the same `content_hlc`, or the same text under a newer one: nothing changes. */
  | "hold";

function later(a: string | undefined, b: string): string {
  return a !== undefined && a >= b ? a : b;
}

export class TextVersions {
  /** Per block: the newest HLC of a text the tree showed (or loaded into the editor) or wrote. */
  private readonly known = new Map<BlockId, string>();
  /** Per block: the newest version offered in a notice and not taken — its HLC and its text. */
  private readonly offered = new Map<BlockId, { hlc: string; text: string | undefined }>();

  /** Ops this tab wrote: `block.text` sets a block's `content_hlc`, and so does `block.create`. */
  noteWrites(ops: readonly Pick<Op, "hlc" | "entity" | "payload">[]): void {
    for (const op of ops) {
      const kind = op.payload.kind;
      if (kind === "block.text" || kind === "block.create") this.noteShown(op.entity, op.hlc);
    }
  }

  /** The tree put a fetched text on screen, or into the editor. */
  noteShown(id: BlockId, hlc: string): void {
    this.known.set(id, later(this.known.get(id), hlc));
  }

  /** `hlc` is newer than any text of `id` this tab has shown or written. A block never seen is not:
   * with nothing to compare, the buffer wins, as it always did. */
  isNewer(id: BlockId, hlc: string): boolean {
    const known = this.known.get(id);
    return known !== undefined && hlc > known;
  }

  /**
   * The verdict for a fetched text of the block being edited. `sameText`: it says what the buffer
   * already says. `unsaved`: the buffer holds typing not yet written. `sameAsBeforeTyping`: it says
   * what the buffer said before that typing began. `text`: its editing text, which tells a version
   * already offered arriving again under a newer HLC (a marker flip of it) from a new one.
   *
   * Records what it decides: a taken or matching version becomes known; an offered one becomes
   * offered but NOT known — the database still holds it, and if the typing's write later loses to
   * it (a clock ahead of ours) the next refetch must still see it as newer and take it.
   */
  decide(
    id: BlockId,
    hlc: string,
    state: { sameText: boolean; unsaved: boolean; sameAsBeforeTyping?: boolean; text?: string },
  ): RemoteVerdict {
    if (!this.isNewer(id, hlc)) {
      // A block first seen while being edited (created elsewhere, then focused before any refetch
      // showed it) starts known from here.
      if (!this.known.has(id)) this.noteShown(id, hlc);
      return "keep";
    }
    if (state.sameText || !state.unsaved) {
      this.noteShown(id, hlc);
      this.offered.delete(id);
      return state.sameText ? "same" : "take";
    }
    if (state.sameAsBeforeTyping) {
      // Not known, like an offered version: if the typing's write still loses to it, the next
      // refetch with nothing unsaved takes it, and the editor never shows text the database lacks.
      this.offered.delete(id);
      return "untouched";
    }
    const offered = this.offered.get(id);
    if (offered !== undefined && offered.hlc >= hlc) return "hold";
    // The text already offered, under a newer HLC: a write that left it alone — an agent flipping
    // the task marker — is not a new version, and a dismissed notice must not come back (B-464).
    if (offered !== undefined && state.text !== undefined && offered.text === state.text) {
      this.offered.set(id, { hlc, text: offered.text });
      return "hold";
    }
    this.offered.set(id, { hlc, text: state.text });
    return "offer";
  }

  /** The offered version was taken into the buffer (and written): it is known now. */
  taken(id: BlockId, hlc: string): void {
    this.noteShown(id, hlc);
    this.offered.delete(id);
  }
}

/**
 * Where a caret at `pos` in `before` belongs once the whole text is replaced by `after`, for a
 * rewrite that arrives while someone is editing. Only the span between the two texts' common
 * prefix and common suffix changed: a caret before that span keeps its offset, one after it keeps
 * its distance from the end, and one inside it goes to the end of the new span — the place a
 * person was typing towards. A caret at the end stays at the end, text appended there included:
 * wrapping a whole line (`Probe` → `[[Probe]]`) with the caret at the end keeps it after `]]`.
 */
export function mapThroughRewrite(before: string, after: string, pos: number): number {
  const at = Math.max(0, Math.min(pos, before.length));
  let prefix = 0;
  const max = Math.min(before.length, after.length);
  while (prefix < max && before.charCodeAt(prefix) === after.charCodeAt(prefix)) prefix++;
  // Never between the halves of a surrogate pair (an emoji): a caret there is not a position.
  if (prefix > 0 && isHighSurrogate(before.charCodeAt(prefix - 1))) prefix--;
  let suffix = 0;
  while (
    suffix < max - prefix &&
    before.charCodeAt(before.length - 1 - suffix) === after.charCodeAt(after.length - 1 - suffix)
  )
    suffix++;
  if (suffix > 0 && isLowSurrogate(after.charCodeAt(after.length - suffix))) suffix--;
  if (at === before.length) return after.length;
  if (at <= prefix) return at;
  if (at >= before.length - suffix) return after.length - (before.length - at);
  return after.length - suffix;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}
