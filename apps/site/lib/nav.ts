import type { NavGroup } from "@/components/DocPageView";
import { allPages, type Collection, type DocPage } from "./source.ts";

export function navGroups(): NavGroup[] {
  const { docs, decisions } = allPages();
  const groups: NavGroup[] = [{ title: "Guide", pages: docs }];
  if (decisions.length) groups.push({ title: "Design decisions", pages: decisions, numbered: true });
  return groups;
}

export function findPage(collection: Collection, slug: string) {
  const list = allPages()[collection];
  const i = list.findIndex((p) => p.slug === slug);
  const page = list[i];
  if (!page) return null;
  const neighbour = (j: number): DocPage | undefined => list[j];
  return { page, prev: neighbour(i - 1), next: neighbour(i + 1) };
}
