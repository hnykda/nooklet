"use client";

import "./sync.css";
import { FigureFrame, type Step, useStepper } from "./Figure";
import { Device, type Line, type LogEntry, Server, Wire } from "./parts";

// Drawn from the "Two devices edit offline and converge" animation-spec in
// docs/guide/how-it-works.md. Keep the two in step if either changes.
const STEPS: readonly Step[] = [
  { caption: "Both devices go offline. Each keeps working from its own copy.", hold: 2200 },
  {
    caption:
      "On the laptop, “Buy milk” becomes “Buy oat milk”. The op waits in the laptop’s outbox.",
    hold: 2800,
  },
  {
    caption:
      "On the phone, the same block gets a scheduled date. That op waits in the phone’s outbox.",
    hold: 2800,
  },
  {
    caption:
      "The laptop reconnects and pushes. The server logs the op as seq 41 and pokes the phone, which is still offline.",
    hold: 3000,
  },
  {
    caption: "The phone reconnects and pushes seq 42. Then each device pulls the op it missed.",
    hold: 2600,
  },
  {
    caption:
      "Both devices show “Buy oat milk” with the date. The edits touched different fields, so both survive.",
    hold: 4000,
  },
];

const OAT = (
  <>
    Buy <ins>oat</ins> milk
  </>
);

function lines(text: boolean, prop: boolean, freshText: boolean, freshProp: boolean): Line[] {
  const out: Line[] = [{ id: "b", text: text ? OAT : "Buy milk", fresh: freshText }];
  if (prop) {
    out.push({
      id: "p",
      prop: true,
      fresh: freshProp,
      text: (
        <>
          scheduled:: <ins>2026-10-05</ins>
        </>
      ),
    });
  }
  return out;
}

export function Converge() {
  const stepper = useStepper(STEPS);
  const s = stepper.step;
  const laptopOnline = s >= 3;
  const phoneOnline = s >= 4;

  const log: LogEntry[] = [{ seq: 40, kind: "block.create", from: "phone" }];
  if (s >= 3) log.push({ seq: 41, kind: "block.text", from: "laptop", fresh: s === 3 });
  if (s >= 4) log.push({ seq: 42, kind: "block.prop", from: "phone", fresh: s === 4 });

  const laptopOutbox = s >= 1 && s < 3 ? [{ key: "t", label: "block.text, HLC 10:00:05" }] : [];
  const phoneOutbox = s >= 2 && s < 4 ? [{ key: "p", label: "block.prop, HLC 10:00:09" }] : [];

  return (
    <FigureFrame
      name="sync-converge"
      label="Animation: two devices edit the same block offline, reconnect, and converge"
      steps={STEPS}
      stepper={stepper}
    >
      <div className="sync-grid">
        <Device
          who="laptop"
          lines={lines(s >= 1, s >= 4, s === 1, s === 4)}
          online={laptopOnline}
          outbox={laptopOutbox}
        />
        <Wire
          side="left"
          online={laptopOnline}
          stepKey={s}
          ops={
            s === 3
              ? [{ from: "laptop", dir: "in" }]
              : s === 4
                ? [{ from: "phone", dir: "out" }]
                : []
          }
        />
        <Server
          log={log}
          note={
            s === 3
              ? "poke → phone: no connection"
              : s === 4
                ? "both pull what they missed"
                : undefined
          }
        />
        <Wire
          side="right"
          online={phoneOnline}
          stepKey={s}
          ops={
            s === 3
              ? [{ from: "server", dir: "out", stop: "gap" }]
              : s === 4
                ? [
                    { from: "phone", dir: "in" },
                    { from: "laptop", dir: "out" },
                  ]
                : []
          }
        />
        <Device
          who="phone"
          lines={lines(s >= 4, s >= 2, s === 4, s === 2)}
          online={phoneOnline}
          outbox={phoneOutbox}
        />
      </div>
    </FigureFrame>
  );
}
