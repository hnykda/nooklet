-- Settles: what shape are the owner's linked references in? (2026-09-13, B-550)
--
-- Linked references are `path_ref` rows, so every descendant of a block linking a page is a linked
-- reference too (docs/spec/sql-schema.md rule 12). Before rendering references with their children
-- nested, this measured how many of them are "outermost" (no parent that is also a reference) —
-- the rows a nested panel shows — how big the subtrees under those are, how deep their ancestor
-- chains go (breadcrumbs), and how many are stored collapsed.
--
-- Run on a COPY of the graph, never ~/.nooklet/default:
--   sqlite3 ~/.nooklet/default/graph.sqlite ".backup '<dir>/graph.sqlite'"
--   sqlite3 <dir>/graph.sqlite < tools/probes/references-shape-real-graph.sql
--
-- Result on 2026-09-13 (page | refs | outermost | outermost at top level | pages):
--   @robin 242/47/33/39, @alex 756/91/49/74, call 574/21/21/18, camp 836/34/32/28,
--   fs 463/40/34/39, journal 912/66/34/64, weekly review 1092/86/83/82,
--   task 1074/584/53/136
-- Subtrees (page | outermost | descendants | largest | >30 | >10 | deepest):
--   @robin 47/195/35/1/4/3, @alex 91/665/55/1/26/7, call 21/553/107/6/16/7, camp 34/802/233/6/14/7,
--   fs 40/423/57/2/15/4, journal 66/846/54/7/28/6, weekly review 86/1006/56/5/39/8,
--   task 584/490/72/2/12/5
-- (descendants = refs − outermost on every page: the subtrees hold exactly the other references.)
.mode tabs
DROP TABLE IF EXISTS temp.keys;
CREATE TEMP TABLE keys(k TEXT);
INSERT INTO keys VALUES ('@alex'),('task'),('weekly review'),('camp'),('call'),('journal'),('@robin'),('fs');

DROP TABLE IF EXISTS temp.refs;
CREATE TEMP TABLE refs AS
  SELECT DISTINCT pr.page_key AS k, b.id, b.parent_id, b.page_id FROM path_ref pr
  JOIN block b ON b.id = pr.block_id AND b.deleted_at IS NULL
  JOIN page p ON p.id = b.page_id
  WHERE pr.page_key IN (SELECT k FROM keys) AND p.key != pr.page_key;

DROP TABLE IF EXISTS temp.roots;
CREATE TEMP TABLE roots AS
  SELECT r.k, r.id FROM refs r
  WHERE r.parent_id IS NULL
     OR NOT EXISTS (SELECT 1 FROM refs r2 WHERE r2.k = r.k AND r2.id = r.parent_id);

SELECT 'shape', r.k, count(*),
  (SELECT count(*) FROM roots o WHERE o.k = r.k),
  sum(CASE WHEN r.parent_id IS NULL THEN 1 ELSE 0 END),
  count(DISTINCT r.page_id)
FROM refs r GROUP BY r.k;

WITH RECURSIVE sub(k, root, id, depth) AS (
  SELECT k, id, id, 0 FROM roots
  UNION ALL
  SELECT s.k, s.root, c.id, s.depth + 1 FROM block c JOIN sub s ON c.parent_id = s.id
  WHERE c.deleted_at IS NULL
), per AS (SELECT k, root, count(*) - 1 AS n, max(depth) AS d FROM sub GROUP BY k, root)
SELECT 'subtrees', k, count(*), sum(n), max(n),
  sum(CASE WHEN n > 30 THEN 1 ELSE 0 END), sum(CASE WHEN n > 10 THEN 1 ELSE 0 END), max(d)
FROM per GROUP BY k;

WITH RECURSIVE up(k, root, id, depth) AS (
  SELECT r.k, r.id, b.parent_id, 0 FROM roots r JOIN block b ON b.id = r.id
  UNION ALL
  SELECT u.k, u.root, b.parent_id, u.depth + 1 FROM up u JOIN block b ON b.id = u.id
  WHERE u.id IS NOT NULL
)
SELECT 'ancestors', k, count(*) FILTER (WHERE id IS NOT NULL), max(depth) FROM up GROUP BY k;

SELECT 'collapsed outermost', r.k, sum(b.collapsed) FROM roots r JOIN block b ON b.id = r.id
GROUP BY r.k;
