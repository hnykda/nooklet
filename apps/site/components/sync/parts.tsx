/**
 * Building blocks shared by the sync figures: a device with its little outline, the wire between
 * a device and the server with ops travelling on it, and the server's op log.
 *
 * The figures are HTML laid out with CSS grid rather than one big SVG, so the outline text stays
 * at reading size on a phone: the row of laptop, server and phone turns into a column there, and
 * the wires turn vertical with it.
 */

import type { ReactNode } from "react";

export type Who = "laptop" | "phone";

export interface Line {
  text: ReactNode;
  depth?: 0 | 1;
  /** Highlights the line in the device's colour: it just changed here. */
  fresh?: boolean;
  /** Set on a line that only exists in some steps, so it can fade in. */
  id: string;
}

function Glyph({ kind }: { kind: Who | "server" }) {
  if (kind === "laptop") {
    return (
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
        <rect x="4" y="5" width="16" height="11" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
        <path d="M2 19h20" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    );
  }
  if (kind === "phone") {
    return (
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
        <rect x="7" y="2.5" width="10" height="19" rx="2" fill="none" stroke="currentColor" strokeWidth="1.6" />
        <path d="M11 18.5h2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <rect x="4" y="3.5" width="16" height="7" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <rect x="4" y="13.5" width="16" height="7" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="8" cy="7" r="1" fill="currentColor" />
      <circle cx="8" cy="17" r="1" fill="currentColor" />
    </svg>
  );
}

export function Device({
  who,
  lines,
  online,
  outbox,
}: {
  who: Who;
  lines: Line[];
  online: boolean;
  outbox: number;
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
          <li key={l.id} className="mini__line" data-depth={l.depth ?? 0} data-fresh={!!l.fresh}>
            <span className="mini__text">{l.text}</span>
          </li>
        ))}
      </ul>
      <div className="device__outbox" data-pending={outbox > 0}>
        {outbox === 0 ? "Outbox empty" : `Outbox: ${outbox} op${outbox === 1 ? "" : "s"} waiting`}
      </div>
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
            <span className="oplog__seq">#{e.seq}</span>
            <span className="oplog__kind">{e.kind}</span>
          </li>
        ))}
      </ol>
      {note ? <div className="server__note">{note}</div> : null}
    </div>
  );
}

/**
 * A connection. `ops` lists what is moving on it during this step; each op is re-mounted per step
 * (via `stepKey`) so its CSS travel animation runs once from the start.
 */
export function Wire({
  side,
  online,
  ops,
  stepKey,
}: {
  /** Which side of the server this wire is on: the laptop's (left/top) or the phone's. */
  side: "left" | "right";
  online: boolean;
  /** `in` travels toward the server, `out` away from it. `from` picks the colour. */
  ops: { from: Who; dir: "in" | "out" }[];
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
          />
        );
      })}
    </div>
  );
}
