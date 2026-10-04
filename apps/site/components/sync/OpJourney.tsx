"use client";

import "./sync.css";
import { FigureFrame, type Step, useStepper } from "./Figure";
import { Device, type Line, type LogEntry, Server, Wire } from "./parts";

const STEPS: readonly Step[] = [
  { caption: "The laptop and the phone show the same list.", hold: 2200 },
  {
    caption: "You type on the laptop. The new text and its op are saved together, on the laptop.",
    hold: 2800,
  },
  { caption: "The laptop pushes the op to your server.", hold: 1500 },
  { caption: "The server checks it and appends it to the log as number 42.", hold: 2400 },
  { caption: "The server pokes the phone. The phone asks for everything after 41.", hold: 1500 },
  { caption: "The phone applies the op. Both devices show the same list again.", hold: 3600 },
];

const before = "Call the plumber";
const after = (
  <>
    Call the plumber <ins>on Monday</ins>
  </>
);

function lines(edited: boolean, fresh: boolean): Line[] {
  return [
    { id: "h", text: "Saturday" },
    { id: "a", text: "Return library books", depth: 1 },
    { id: "b", text: edited ? after : before, depth: 1, fresh },
    { id: "c", text: "Water the basil", depth: 1 },
  ];
}

const BASE_LOG: LogEntry[] = [
  { seq: 40, kind: "block.create", from: "phone" },
  { seq: 41, kind: "block.place", from: "phone" },
];

export function OpJourney() {
  const stepper = useStepper(STEPS);
  const s = stepper.step;
  const log: LogEntry[] =
    s >= 3 ? [...BASE_LOG, { seq: 42, kind: "block.text", from: "laptop", fresh: s === 3 }] : BASE_LOG;

  return (
    <FigureFrame
      name="sync-op"
      label="Animation: one edit travels from the laptop through the server to the phone"
      steps={STEPS}
      stepper={stepper}
    >
      <div className="sync-grid">
        <Device who="laptop" lines={lines(s >= 1, s === 1)} online outbox={s >= 1 && s < 3 ? 1 : 0} />
        <Wire side="left" online stepKey={s} ops={s === 2 ? [{ from: "laptop", dir: "in" }] : []} />
        <Server log={log} />
        <Wire side="right" online stepKey={s} ops={s === 4 ? [{ from: "laptop", dir: "out" }] : []} />
        <Device who="phone" lines={lines(s >= 5, s === 5)} online outbox={0} />
      </div>
    </FigureFrame>
  );
}
