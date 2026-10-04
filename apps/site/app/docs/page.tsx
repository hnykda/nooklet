import type { Metadata } from "next";
import Link from "next/link";
import { DocShell } from "@/components/DocPageView";
import { navGroups } from "@/lib/nav";
import { allPages, pageUrl } from "@/lib/source";

export const metadata: Metadata = {
  title: "Docs",
  description: "How to install nooklet, sync it between devices, and connect an agent.",
  alternates: { canonical: "/docs" },
};

export default function DocsIndex() {
  const { docs } = allPages();
  return (
    <DocShell groups={navGroups()} current={null}>
      <header className="doc-header">
        <h1>Docs</h1>
        <p className="lede">
          Start with the first page and read down, or jump to the part you need. Press <kbd>/</kbd>{" "}
          to search.
        </p>
      </header>
      <ol className="doc-index">
        {docs.map((p) => (
          <li key={p.slug}>
            <Link href={pageUrl(p)}>{p.title}</Link>
            {p.description ? <p>{p.description}</p> : null}
          </li>
        ))}
      </ol>
    </DocShell>
  );
}
