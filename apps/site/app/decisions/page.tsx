import type { Metadata } from "next";
import Link from "next/link";
import { DocShell } from "@/components/DocPageView";
import { navGroups } from "@/lib/nav";
import { allPages, pageUrl } from "@/lib/source";

export const metadata: Metadata = {
  title: "Design decisions",
  description:
    "The architecture decision records behind nooklet: what was chosen, what was rejected, and what each choice costs.",
  alternates: { canonical: "/decisions" },
};

export default function DecisionsIndex() {
  const { decisions } = allPages();
  return (
    <DocShell groups={navGroups()} current={null}>
      <header className="doc-header">
        <h1>Design decisions</h1>
        <p className="lede">
          Each record names a choice, the alternatives it beat, and what it costs. They are the same
          files as <code>docs/adr/</code> in the repository, published as written.
        </p>
      </header>
      <ol className="doc-index">
        {decisions.map((p) => (
          <li key={p.slug}>
            <Link href={pageUrl(p)}>
              <span className="sidebar-num">{String(p.order).padStart(3, "0")}</span>
              {p.title}
            </Link>
            {p.description ? <p>{p.description}</p> : null}
          </li>
        ))}
      </ol>
    </DocShell>
  );
}
