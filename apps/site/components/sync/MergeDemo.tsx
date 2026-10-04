"use client";

import "./sync.css";
import type { ReactNode } from "react";
import { FigureFrame, type Step, useStepper } from "./Figure";

const STEPS: readonly Step[] = [
  { caption: "Both devices start from the same block.", hold: 2000 },
  { caption: "Offline, the laptop adds words at the end and the phone adds one in the middle.", hold: 3000 },
  {
    caption: "The edits touch different words, so nooklet merges them against the starting text. You get both.",
    hold: 3800,
  },
  { caption: "Another time, both devices change the same words.", hold: 3000 },
  {
    caption:
      "That cannot merge cleanly. The later edit wins, and the other text stays on the block as a conflict_copy property for you to read.",
    hold: 5200,
  },
];

const L = ({ children }: { children: ReactNode }) => <ins className="by-laptop">{children}</ins>;
const P = ({ children }: { children: ReactNode }) => <ins className="by-phone">{children}</ins>;

function Row({
  label,
  who,
  children,
  fresh,
  extra,
}: {
  label: string;
  who?: "laptop" | "phone" | "result";
  children: ReactNode;
  fresh?: boolean;
  extra?: ReactNode;
}) {
  return (
    <div className={`merge-row merge-row--${who ?? "base"}`} data-fresh={!!fresh}>
      <span className="merge-row__label">{label}</span>
      <div className="merge-row__block">
        <span className="merge-row__text">{children}</span>
        {extra}
      </div>
    </div>
  );
}

export function MergeDemo() {
  const stepper = useStepper(STEPS);
  const s = stepper.step;
  const conflict = s >= 3;

  return (
    <FigureFrame
      name="sync-merge"
      label="Animation: two edits to the same block merge word by word, and an overlapping edit is kept as a conflict copy"
      steps={STEPS}
      stepper={stepper}
    >
      <div className="merge" data-phase={conflict ? "conflict" : "clean"}>
        <Row label="Starting text">Call the plumber</Row>
        <Row label="Laptop" who="laptop" fresh={s === 1 || s === 3}>
          {s === 0 ? (
            "Call the plumber"
          ) : conflict ? (
            <>
              Call the plumber <L>on Monday</L>
            </>
          ) : (
            <>
              Call the plumber <L>before Friday</L>
            </>
          )}
        </Row>
        <Row label="Phone" who="phone" fresh={s === 1 || s === 3}>
          {s === 0 ? (
            "Call the plumber"
          ) : conflict ? (
            <>
              Call the plumber <P>on Tuesday</P>
            </>
          ) : (
            <>
              Call the <P>good</P> plumber
            </>
          )}
        </Row>
        <Row
          label="Everywhere, after sync"
          who="result"
          fresh={s === 2 || s === 4}
          extra={
            s === 4 ? (
              <span className="merge-row__prop">
                <span className="merge-row__key">conflict_copy::</span> Call the plumber on Monday
              </span>
            ) : null
          }
        >
          {s === 2 ? (
            <>
              Call the <P>good</P> plumber <L>before Friday</L>
            </>
          ) : s === 4 ? (
            <>
              Call the plumber <P>on Tuesday</P>
            </>
          ) : s === 0 ? (
            "Call the plumber"
          ) : (
            <span className="merge-row__wait">Waiting for both devices to sync</span>
          )}
        </Row>
      </div>
    </FigureFrame>
  );
}
