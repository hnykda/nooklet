"use client";

import "./sync.css";
import { FigureFrame, type Step, useStepper } from "./Figure";
import { Device, type Line, type LogEntry, Server, Wire } from "./parts";

const STEPS: readonly Step[] = [
  { caption: "Both devices hold the same outline.", hold: 2000 },
  { caption: "The connection drops. Each device keeps working from its own copy.", hold: 2200 },
  {
    caption: "The laptop changes a block. The phone adds one. Each op waits in its own outbox.",
    hold: 3000,
  },
  { caption: "Back online, each device pushes what it wrote.", hold: 1500 },
  { caption: "The server logs both ops, and each device pulls the one it missed.", hold: 1600 },
  {
    caption: "Both edits survive, and both devices put the new block in the same place.",
    hold: 3800,
  },
];

function laptopLines(s: number): Line[] {
  const edited = s >= 2;
  const out: Line[] = [
    { id: "h", text: "Trip to the coast" },
    {
      id: "a",
      text: edited ? (
        <>
          Book the train <ins>for 7:40</ins>
        </>
      ) : (
        "Book the train"
      ),
      depth: 1,
      fresh: s === 2,
    },
    { id: "b", text: "Pack the charger", depth: 1 },
  ];
  if (s >= 5) out.push({ id: "c", text: <ins>Buy snacks</ins>, depth: 1, fresh: s === 5 });
  return out;
}

function phoneLines(s: number): Line[] {
  const out: Line[] = [
    { id: "h", text: "Trip to the coast" },
    {
      id: "a",
      text:
        s >= 5 ? (
          <>
            Book the train <ins>for 7:40</ins>
          </>
        ) : (
          "Book the train"
        ),
      depth: 1,
      fresh: s === 5,
    },
    { id: "b", text: "Pack the charger", depth: 1 },
  ];
  if (s >= 2) out.push({ id: "c", text: <ins>Buy snacks</ins>, depth: 1, fresh: s === 2 });
  return out;
}

export function Converge() {
  const stepper = useStepper(STEPS);
  const s = stepper.step;
  const online = s === 0 || s >= 3;
  const log: LogEntry[] = [{ seq: 42, kind: "block.text", from: "laptop" }];
  if (s >= 4) {
    log.push({ seq: 43, kind: "block.text", from: "laptop", fresh: s === 4 });
    log.push({ seq: 44, kind: "block.create", from: "phone", fresh: s === 4 });
  }
  const pending = s === 2 || s === 3 ? 1 : 0;

  return (
    <FigureFrame
      name="sync-converge"
      label="Animation: two devices edit offline, reconnect, and converge"
      steps={STEPS}
      stepper={stepper}
    >
      <div className="sync-grid">
        <Device who="laptop" lines={laptopLines(s)} online={online} outbox={pending} />
        <Wire
          side="left"
          online={online}
          stepKey={s}
          ops={s === 3 ? [{ from: "laptop", dir: "in" }] : s === 4 ? [{ from: "phone", dir: "out" }] : []}
        />
        <Server log={log.slice(-3)} />
        <Wire
          side="right"
          online={online}
          stepKey={s}
          ops={s === 3 ? [{ from: "phone", dir: "in" }] : s === 4 ? [{ from: "laptop", dir: "out" }] : []}
        />
        <Device who="phone" lines={phoneLines(s)} online={online} outbox={pending} />
      </div>
    </FigureFrame>
  );
}
