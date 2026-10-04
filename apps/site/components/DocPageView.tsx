import Link from "next/link";
import type { RenderedPage } from "@/lib/render";
import { type DocPage, pageUrl, REPO_URL } from "@/lib/source";
import { ANIMATIONS } from "./sync/registry";
import { Toc } from "./Toc";

export interface NavGroup {
  title: string;
  pages: DocPage[];
  numbered?: boolean;
}

function Sidebar({ groups, current }: { groups: NavGroup[]; current: DocPage | null }) {
  return (
    <aside className="docs-sidebar" aria-label="Documentation">
      <details open>
        <summary>All pages</summary>
        {groups.map((g) => (
          <nav key={g.title} className="sidebar-group" aria-label={g.title}>
            <h2>{g.title}</h2>
            <ul className="sidebar-list">
              {g.pages.map((p) => (
                <li key={p.slug}>
                  <Link
                    href={pageUrl(p)}
                    aria-current={current && pageUrl(current) === pageUrl(p) ? "page" : undefined}
                  >
                    {g.numbered ? <span className="sidebar-num">{String(p.order).padStart(3, "0")}</span> : null}
                    {p.title}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        ))}
      </details>
    </aside>
  );
}

export function DocShell({
  groups,
  current,
  toc,
  children,
}: {
  groups: NavGroup[];
  current: DocPage | null;
  toc?: RenderedPage["toc"];
  children: React.ReactNode;
}) {
  return (
    <div className="docs-shell">
      <Sidebar groups={groups} current={current} />
      <main id="main" className="docs-main">
        {children}
      </main>
      {toc && toc.length > 1 ? <Toc items={toc} /> : <div />}
    </div>
  );
}

export function DocArticle({
  page,
  rendered,
  prev,
  next,
}: {
  page: DocPage;
  rendered: RenderedPage;
  prev?: DocPage;
  next?: DocPage;
}) {
  const isAdr = page.collection === "decisions";
  return (
    <article>
      <header className="doc-header">
        <h1>{isAdr ? `ADR ${String(page.order).padStart(3, "0")}: ${page.title}` : page.title}</h1>
        {page.description && !isAdr ? <p className="lede">{page.description}</p> : null}
        <div className="doc-meta">
          <a href={`${REPO_URL}/blob/main/${page.repoPath}`}>View source on GitHub</a>
          <a href={`${pageUrl(page)}.md`}>Read as markdown</a>
        </div>
      </header>
      <div className="prose">
        {rendered.segments.map((seg, i) => {
          if (seg.kind === "html") {
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: segments are static build output
              // biome-ignore lint/security/noDangerouslySetInnerHtml: HTML rendered at build time from the repo's own markdown
              <div key={i} className="prose-chunk" dangerouslySetInnerHTML={{ __html: seg.html }} />
            );
          }
          const Anim = ANIMATIONS[seg.anim.id];
          // biome-ignore lint/suspicious/noArrayIndexKey: segments are static build output
          if (Anim) return <Anim key={i} />;
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: segments are static build output
            <figure key={i} className="anim-pending">
              <figcaption>Animation not drawn yet: {seg.anim.caption}</figcaption>
            </figure>
          );
        })}
      </div>
      {prev || next ? (
        <nav className="doc-pager" aria-label="Previous and next page">
          {prev ? (
            <Link href={pageUrl(prev)} className="prev">
              <small>Previous</small>
              {prev.title}
            </Link>
          ) : null}
          {next ? (
            <Link href={pageUrl(next)} className="next">
              <small>Next</small>
              {next.title}
            </Link>
          ) : null}
        </nav>
      ) : null}
    </article>
  );
}
