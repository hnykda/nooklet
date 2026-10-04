import type { MetadataRoute } from "next";
import { allPages, pageUrl, SITE_URL } from "@/lib/source";

export const dynamic = "force-static";

export default function sitemap(): MetadataRoute.Sitemap {
  const { docs, decisions } = allPages();
  return [
    { url: `${SITE_URL}/`, priority: 1 },
    { url: `${SITE_URL}/docs`, priority: 0.9 },
    ...docs.map((p) => ({ url: `${SITE_URL}${pageUrl(p)}`, priority: 0.8 })),
    { url: `${SITE_URL}/decisions`, priority: 0.5 },
    ...decisions.map((p) => ({ url: `${SITE_URL}${pageUrl(p)}`, priority: 0.4 })),
  ];
}
