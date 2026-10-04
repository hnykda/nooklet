import type { ComponentType } from "react";
import { Converge } from "./Converge";
import { MergeDemo } from "./MergeDemo";
import { OpJourney } from "./OpJourney";

/**
 * Animations a guide page can embed with an ```` ```animation-spec ```` fence whose `id` is one
 * of these keys. A fence naming an id that is not here renders as a described placeholder and
 * the build prints a warning, so the gap is visible rather than silent.
 */
export const ANIMATIONS: Record<string, ComponentType> = {
  "sync-op": OpJourney,
  "sync-converge": Converge,
  "sync-merge": MergeDemo,
};
