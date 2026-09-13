/**
 * B-192: the line under the block being edited when its text was rewritten elsewhere while it held
 * typing not yet saved. The typing stays — it is what the person is looking at and still doing —
 * and this says the block also has another version, with a way to take it.
 *
 * Inline on the row rather than a toast: it is about this block, and stays until it is answered
 * or editing moves on. Both buttons keep the editor's focus (mousedown is prevented), so "Keep
 * mine" lets typing carry on where it was.
 */
import "./remote-change-notice.css";

export function RemoteChangeNotice(props: {
  /** The other version's editing text, shown as the take button's tooltip. */
  other: string;
  onTake: () => void;
  onKeep: () => void;
}) {
  return (
    <div class="vr-remote-notice" role="status">
      <span class="vr-remote-notice-text">This block changed elsewhere.</span>
      <button
        type="button"
        class="vr-remote-notice-button"
        title={props.other}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => props.onTake()}
      >
        Use the other version
      </button>
      <button
        type="button"
        class="vr-remote-notice-button vr-remote-notice-keep"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => props.onKeep()}
      >
        Keep mine
      </button>
    </div>
  );
}
