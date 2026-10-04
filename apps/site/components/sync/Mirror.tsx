"use client";

import "./sync.css";
import type { ReactNode } from "react";
import { FigureFrame, type Step, useStepper } from "./Figure";
import { Glyph, Wire } from "./parts";

// Drawn from the "The database is the truth; the files are a copy" animation-spec in
// docs/guide/how-it-works.md. Keep the two in step if either changes.
const STEPS: readonly Step[] = [
  {
    caption: "An op lands in the server’s SQLite database: a block on “Reading list” changed.",
    hold: 2400,
  },
  {
    caption:
      "A moment later the server rewrites Reading list.md. Each line ends with the block’s ^id.",
    hold: 2800,
  },
  { caption: "The file is plain text, so grep finds it and git can commit it.", hold: 2800 },
  {
    caption:
      "You edit the file by hand. nooklet does not watch the folder, so the change goes nowhere.",
    hold: 3000,
  },
  {
    caption:
      "The next op on that page rewrites the file from the database, and the hand edit is gone. Edit through the app or the API instead.",
    hold: 4600,
  },
];

interface FileLine {
  id: string;
  text: ReactNode;
  blockId: string;
  state?: "fresh" | "hand" | "found";
}

function fileLines(s: number): FileLine[] {
  const out: FileLine[] = [
    {
      id: "a",
      text: s === 3 ? "- The Dispossessed, reread" : "- The Dispossessed",
      blockId: "1m433dkhgaxame",
      state: s === 3 ? "hand" : undefined,
    },
    {
      id: "b",
      text: s >= 1 ? "- Piranesi, finished in March" : "- Piranesi",
      blockId: "1m433dkhgaxamf",
      state: s === 1 ? "fresh" : s === 2 ? "found" : undefined,
    },
  ];
  if (s >= 4)
    out.push({ id: "c", text: "- Klara and the Sun", blockId: "1m433dkhgaxamg", state: "fresh" });
  return out;
}

// Newest first, the order a VCS log prints them.
const COMMITS = ["9c41e0a reading list", "51d2b7f journal", "e07a3c2 garden shed"];

export function Mirror() {
  const stepper = useStepper(STEPS);
  const s = stepper.step;
  const kinds = ["page.create", "block.create", "block.create", "block.text"];
  if (s >= 4) kinds.push("block.create");
  const ops = kinds.map((kind, i) => ({ kind, n: i + 1 }));
  const commits = s >= 2 ? 3 : 2;

  return (
    <FigureFrame
      name="sync-mirror"
      label="Animation: the server database writes markdown files, and a hand edit to a file does not flow back"
      steps={STEPS}
      stepper={stepper}
    >
      <div className="sync-grid sync-grid--mirror">
        <div className="server">
          <div className="device__head">
            <span className="device__name">
              <Glyph kind="db" />
              Server database
            </span>
          </div>
          <ol className="oplog" aria-label="Ops in the database">
            {ops.slice(-3).map((op) => (
              <li
                key={op.n}
                className="oplog__row oplog__row--ink"
                data-fresh={(s === 0 || s === 4) && op.n === ops.length}
              >
                <span className="oplog__kind">{op.kind}</span>
              </li>
            ))}
          </ol>
          <div className="server__note">the truth</div>
        </div>
        <Wire
          side="left"
          online
          stepKey={s}
          ops={
            s === 1 || s === 4
              ? [{ from: "server", dir: "in" }]
              : s === 3
                ? [{ from: "hand", dir: "out", stop: "gap" }]
                : []
          }
        />
        <div className="file">
          <div className="device__head">
            <span className="device__name">
              <Glyph kind="folder" />
              pages/Reading list.md
            </span>
          </div>
          <pre className="file__body">
            {fileLines(s).map((l) => (
              <span key={l.id} className="file__line" data-state={l.state}>
                {l.text} <span className="file__id">^{l.blockId}</span>
                {"\n"}
              </span>
            ))}
          </pre>
          <div className="server__note" data-hand={s === 3}>
            {s === 3 ? "edited by hand: not watched" : "a copy, rewritten on change"}
          </div>
        </div>
        <Wire side="right" online stepKey={s} ops={[]} />
        <div className="tools" data-active={s === 2}>
          <div className="device__head">
            <span className="device__name">Your tools</span>
          </div>
          <pre className="tools__term">
            <span className="tools__prompt">$ grep -rn Piranesi pages/</span>
            {"\n"}
            {s >= 1 ? "Reading list.md:2: Piranesi, finished…" : "Reading list.md:2: Piranesi"}
            {"\n"}
            <span className="tools__prompt">$ git log --oneline</span>
            {"\n"}
            {COMMITS.slice(COMMITS.length - commits).map((c) => (
              <span
                key={c}
                className="tools__commit"
                data-fresh={s === 2 && c === COMMITS[COMMITS.length - commits]}
              >
                ● {c}
                {"\n"}
              </span>
            ))}
          </pre>
        </div>
      </div>
    </FigureFrame>
  );
}
