/**
 * TODO(views): placeholder for the page view (outline rendering, refs panels, properties). The
 * editor agent owns the actual block rendering/editing; this just proves `usePageTree` resolves
 * by route param.
 */
import { useParams } from "@solidjs/router";
import { usePageTree } from "../data/store.js";

export function PageRoute() {
  const params = useParams<{ id: string }>();
  const tree = usePageTree(() => params.id);

  return (
    <div class="placeholder-view">
      <p>
        TODO(views): render this page's outline (editor agent owns block rendering/editing). Data
        seam: <code>usePageTree(pageId)</code> in <code>src/data/store.ts</code>.
      </p>
      {tree.loading && <p>Loading…</p>}
      {!tree.loading && !tree() && <p>Page not found: {params.id}</p>}
      {tree() && (
        <>
          <h1>{tree()?.page.name}</h1>
          <p>{tree()?.blocks.length} top-level block(s)</p>
        </>
      )}
    </div>
  );
}
