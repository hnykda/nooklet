import type { ComponentType } from "react";
import type { AnimationRef } from "@/lib/render";
import { Converge } from "./Converge";
import { MergeDemo } from "./MergeDemo";
import { Mirror } from "./Mirror";
import { OpJourney } from "./OpJourney";

/**
 * The animations the site draws. A guide page embeds one with an ```` ```animation-spec ````
 * fence. The guide's specs carry a `title` (no id), so each entry matches by `id` if the spec has
 * one and otherwise by a pattern on the title. A spec that matches nothing renders as a described
 * placeholder and `next build` logs a warning, so a new spec is visible rather than silently lost.
 */
const ENTRIES: { id: string; title: RegExp; component: ComponentType }[] = [
  { id: "sync-converge", title: /offline.*converge|converge/i, component: Converge },
  { id: "sync-op", title: /one op travels|device to server/i, component: OpJourney },
  { id: "sync-mirror", title: /files are a copy|database is the truth|mirror/i, component: Mirror },
  { id: "sync-merge", title: /merge|conflict/i, component: MergeDemo },
];

export function findAnimation(ref: AnimationRef): ComponentType | undefined {
  const byId = ENTRIES.find((e) => e.id === ref.id);
  if (byId) return byId.component;
  const byTitle = ENTRIES.find((e) => e.title.test(ref.title));
  if (byTitle) return byTitle.component;
  console.warn(`site: no animation drawn for animation-spec "${ref.title || ref.id}"`);
  return undefined;
}
