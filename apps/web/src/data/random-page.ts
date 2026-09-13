/**
 * The pages `nav.randomPage` may land on (`commands/registrations/random-page.ts` says why these
 * and not all pages), from the local replica. Its own module so the hookup stays a new file.
 */

import type { RandomPageCandidate } from "../commands/registrations/random-page.js";
import { queryAs } from "../db/client.js";

/** Exported for `random-page.test.ts`, which runs it against a real replica schema. */
export const RANDOM_PAGE_CANDIDATES_SQL = `SELECT p.id AS id, p.name AS name FROM page p
  WHERE p.deleted_at IS NULL AND p.journal_day IS NULL
    AND EXISTS (SELECT 1 FROM block b WHERE b.page_id = p.id AND b.deleted_at IS NULL)`;

export function listRandomPageCandidates(): Promise<RandomPageCandidate[]> {
  return queryAs<RandomPageCandidate>(RANDOM_PAGE_CANDIDATES_SQL);
}
