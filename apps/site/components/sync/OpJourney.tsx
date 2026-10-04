"use client";

import "./sync.css";
import { FigureFrame, type Step, useStepper } from "./Figure";
import { Device, Glyph, type Line, type LogEntry, Server, Wire } from "./parts";

// Drawn from the "One op travels from device to server to another device" animation-spec in
// docs/guide/how-it-works.md. Keep the two in step if either changes.
const STEPS: readonly Step[] = [
  {
    caption: "You type “Call the plumber” into a new block on the phone. It shows up at once.",
    hold: 2400,
  },
  {
    caption:
      "In one transaction, the phone writes the op to its own SQLite and puts a copy in its outbox.",
    hold: 2800,
  },
  { caption: "A moment later the phone sends the outbox: POST /sync/push.", hold: 1700 },
  {
    caption: "The server checks that the tree stays valid, stores the op, and logs it as seq 128.",
    hold: 2600,
  },
  { caption: "The server acknowledges. The phone’s outbox empties.", hold: 1900 },
  { caption: "The server pokes the laptop over its WebSocket.", hold: 1700 },
  {
    caption: "The laptop asks for what it lacks: GET /sync/pull?since=127. Seq 128 comes back.",
    hold: 2000,
  },
  {
    caption: "“Call the plumber” appears on the laptop. Both devices’ cursors read 128.",
    hold: 4000,
  },
];

const OP = "block.create, HLC 14:02:11.120-0000-phone";

function lines(has: boolean, fresh: boolean): Line[] {
  const out: Line[] = [
    { id: "h", text: "Saturday" },
    { id: "a", text: "Return library books", depth: 1 },
  ];
  if (has) out.push({ id: "b", text: <ins>Call the plumber</ins>, depth: 1, fresh });
  return out;
}

function Db({ count, fresh }: { count: number; fresh?: boolean }) {
  return (
    <span className="db" data-fresh={!!fresh}>
      <Glyph kind="db" />
      SQLite, cursor {count}
    </span>
  );
}

const BASE_LOG: LogEntry[] = [
  { seq: 126, kind: "block.text", from: "laptop" },
  { seq: 127, kind: "block.place", from: "laptop" },
];

const NOTES: Record<number, string> = {
  2: "← POST /sync/push",
  3: "✓ tree valid",
  4: "→ ack to phone",
  5: "→ poke to laptop",
  6: "← GET /sync/pull?since=127",
};

export function OpJourney() {
  const stepper = useStepper(STEPS);
  const s = stepper.step;
  const log: LogEntry[] =
    s >= 3
      ? [...BASE_LOG, { seq: 128, kind: "block.create", from: "phone", fresh: s === 3 }]
      : BASE_LOG;

  return (
    <FigureFrame
      name="sync-op"
      label="Animation: one op travels from the phone through the server to the laptop"
      steps={STEPS}
      stepper={stepper}
    >
      <div className="sync-grid">
        <Device
          who="phone"
          lines={lines(true, s === 0)}
          online
          outbox={s >= 1 && s < 4 ? [{ key: "op", label: OP }] : []}
          footer={<Db count={s >= 4 ? 128 : 127} fresh={s === 1} />}
        />
        <Wire
          side="left"
          online
          stepKey={s}
          ops={
            s === 2
              ? [{ from: "phone", dir: "in" }]
              : s === 4
                ? [{ from: "server", dir: "out" }]
                : []
          }
        />
        <Server log={log} note={NOTES[s]} />
        <Wire
          side="right"
          online
          stepKey={s}
          ops={
            s === 5
              ? [{ from: "server", dir: "out" }]
              : s === 6
                ? [{ from: "phone", dir: "out" }]
                : []
          }
        />
        <Device
          who="laptop"
          lines={lines(s >= 7, s === 7)}
          online
          outbox={[]}
          footer={<Db count={s >= 6 ? 128 : 127} fresh={s === 6} />}
        />
      </div>
    </FigureFrame>
  );
}
