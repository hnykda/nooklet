import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DocArticle, DocShell } from "@/components/DocPageView";
import { findPage, navGroups } from "@/lib/nav";
import { renderPage } from "@/lib/render";
import { allPages, pageUrl } from "@/lib/source";

export const dynamicParams = false;

export function generateStaticParams() {
  return allPages().decisions.map((p) => ({ slug: p.slug }));
}

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const found = findPage("decisions", (await params).slug);
  if (!found) return {};
  const { page } = found;
  const title = `ADR ${String(page.order).padStart(3, "0")}: ${page.title}`;
  return {
    title,
    description: page.description,
    alternates: {
      canonical: pageUrl(page),
      types: { "text/markdown": `${pageUrl(page)}.md` },
    },
    openGraph: { title, description: page.description, url: pageUrl(page), type: "article" },
  };
}

export default async function DecisionPage({ params }: Props) {
  const found = findPage("decisions", (await params).slug);
  if (!found) notFound();
  const rendered = await renderPage(found.page);
  return (
    <DocShell groups={navGroups()} current={found.page} toc={rendered.toc}>
      <DocArticle page={found.page} rendered={rendered} prev={found.prev} next={found.next} />
    </DocShell>
  );
}
