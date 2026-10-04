/**
 * Building blocks shared by the sync figures: a device with its block and outbox, the wire between
 * a device and the server with ops travelling on it, and the server's op log.
 *
 * The figures are HTML laid out with CSS grid rather than one big SVG, so the text stays at
 * reading size on a phone: the row of device, server and device turns into a column there, and
 * the wires turn vertical with it.
 */

import type { ReactNode } from "react";

export type Who = "laptop" | "phone";

export interface Line {
  text: ReactNode;
  depth?: 0 | 1;
  /** Highlights the line in the device's colour: it just changed here. */
  fresh?: boolean;
  /** A property row under the block (`key:: value`), drawn smaller. */
  prop?: boolean;
  id: string;
}

export function Glyph({ kind }: { kind: Who | "server" | "db" | "folder" }) {
  switch (kind) {
    case "laptop":
      return (
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
          <rect
            x="4"
            y="5"
            width="16"
            height="11"
            rx="1.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
          />
          <path d="M2 19h20" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      );
    case "phone":
      return (
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
          <rect
            x="7"
            y="2.5"
            width="10"
            height="19"
            rx="2"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
          />
          <path d="M11 18.5h2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      );
    case "db":
      return (
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
          <ellipse
            cx="12"
            cy="6"
            rx="7"
            ry="2.6"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
          />
          <path
            d="M5 6v12c0 1.4 3.1 2.6 7 2.6s7-1.2 7-2.6V6M5 12c0 1.4 3.1 2.6 7 2.6s7-1.2 7-2.6"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
          />
        </svg>
      );
    case "folder":
      return (
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
          <path
            d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2h8.5A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
          />
        </svg>
      );
    default:
      return (
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
          <rect
            x="4"
            y="3.5"
            width="16"
            height="7"
            rx="1.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
          />
          <rect
            x="4"
            y="13.5"
            width="16"
            height="7"
            rx="1.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
          />
          <circle cx="8" cy="7" r="1" fill="currentColor" />
          <circle cx="8" cy="17" r="1" fill="currentColor" />
        </svg>
      );
  }
}

export interface OpCard {
  key: string;
  label: string;
}

export function Device({
  who,
  lines,
  online,
  outbox,
  footer,
}: {
  who: Who;
  lines: Line[];
  online: boolean;
  /** Op cards waiting to be pushed. */
  outbox: OpCard[];
  /** Extra state under the outbox, such as the device's sync cursor. */
  footer?: ReactNode;
}) {
  return (
    <div className={`device device--${who}`}>
      <div className="device__head">
        <span className="device__name">
          <Glyph kind={who} />
          {who === "laptop" ? "Laptop" : "Phone"}
        </span>
        <span className="device__status" data-online={online}>
          {online ? "online" : "offline"}
        </span>
      </div>
      <ul className="mini">
        {lines.map((l) => (
          <li
            key={l.id}
            className={l.prop ? "mini__prop" : "mini__line"}
            data-depth={l.depth ?? 0}
            data-fresh={!!l.fresh}
          >
            <span className="mini__text">{l.text}</span>
          </li>
        ))}
      </ul>
      <div className="device__outbox" data-pending={outbox.length > 0}>
        <span className="device__outbox-label">Outbox</span>
        {outbox.length === 0 ? (
          <span className="device__outbox-empty">empty</span>
        ) : (
          outbox.map((o) => (
            <span key={o.key} className="card">
              {o.label}
            </span>
          ))
        )}
      </div>
      {footer ? <div className="device__footer">{footer}</div> : null}
    </div>
  );
}

export interface LogEntry {
  seq: number;
  kind: string;
  from: Who;
  fresh?: boolean;
}

export function Server({ log, note }: { log: LogEntry[]; note?: ReactNode }) {
  return (
    <div className="server">
      <div className="device__head">
        <span className="device__name">
          <Glyph kind="server" />
          Your server
        </span>
      </div>
      <ol className="oplog" aria-label="Server op log">
        {log.map((e) => (
          <li key={e.seq} className={`oplog__row oplog__row--${e.from}`} data-fresh={!!e.fresh}>
            <span className="oplog__seq">seq {e.seq}</span>
            <span className="oplog__kind">{e.kind}</span>
          </li>
        ))}
      </ol>
      <div className="server__note" data-empty={!note}>
        {note ?? " "}
      </div>
    </div>
  );
}

export type Travel = { from: Who | "server" | "hand"; dir: "in" | "out"; stop?: "gap" };

/**
 * A connection. `ops` lists what is moving on it during this step; each op is re-mounted per step
 * (via `stepKey`) so its CSS travel animation runs once from the start. An op with `stop: "gap"`
 * is a poke that reaches an offline device's broken line and fades halfway.
 */
export function Wire({
  side,
  online,
  ops,
  stepKey,
}: {
  /** Which side of the server this wire is on: left (top when stacked) or right (bottom). */
  side: "left" | "right";
  online: boolean;
  /** `in` travels toward the server, `out` away from it. `from` picks the colour. */
  ops: Travel[];
  stepKey: number;
}) {
  return (
    <div className="wire" data-online={online} aria-hidden="true">
      <span className="wire__line" />
      {ops.map((o) => {
        // "forward" is left-to-right on a wide screen and top-to-bottom when the figure stacks.
        const forward = (side === "left") === (o.dir === "in");
        return (
          <span
            key={`${stepKey}-${o.from}-${o.dir}`}
            className={`op op--${o.from}`}
            data-travel={forward ? "forward" : "backward"}
            data-stop={o.stop}
          />
        );
      })}
    </div>
  );
}
