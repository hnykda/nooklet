import { buildSearchIndex } from "@/lib/search-index";

export const dynamic = "force-static";

export async function GET() {
  return new Response(await buildSearchIndex(), {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
