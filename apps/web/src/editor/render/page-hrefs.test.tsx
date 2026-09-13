// @vitest-environment jsdom
/**
 * A rendered page link's `href` is the router's own path for that page (B-331): one
 * `encodeURIComponent` per namespace segment, "/" kept, built by `routes/page-path.ts`. Six render
 * sites used `encodeURIComponent` on the whole name, so middle-click / open-in-new-tab / Copy link
 * on `[[Projects/Aurora Launch]]` went to `/page/Projects%2FAurora%20Launch` — which opens the page
 * only because the route happens to decode its splat. The whole path, every way into a page, is
 * `e2e/tests/namespace-paths.spec.ts`.
 */
import { classifyBlockContent } from "@nooklet/core";
import { cleanup, render, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EmbedData } from "../../data/embeds.js";
import type { QueryResults } from "../../data/queries.js";

const NAME = "Projects/Aurora Launch";
const EXPECTED = "/page/Projects/Aurora%20Launch";

vi.mock("../../data/queries.js", () => ({
  useQueryResults: () => ({
    get latest(): QueryResults {
      return {
        matched: 1,
        shown: 1,
        nested: 0,
        truncated: false,
        groups: [
          {
            pageId: "p1",
            pageName: "Projects/Aurora Launch",
            pageJournalDay: null,
            hits: [
              {
                id: "b1",
                pageId: "p1",
                content: "TODO ship",
                marker: "TODO",
                priority: null,
                children: [],
              },
            ],
          },
        ],
      } as unknown as QueryResults;
    },
    error: undefined,
    loading: false,
  }),
}));

vi.mock("../../data/embeds.js", () => ({
  useEmbed: () => ({
    get latest(): EmbedData {
      return {
        status: "page",
        page: {
          id: "p1",
          graphId: "default",
          name: "Projects/Aurora Launch",
          key: "projects/aurora launch",
          journalDay: null,
          createdAt: 1,
          updatedAt: 1,
          deletedAt: null,
          nameHlc: "h",
          deletedHlc: null,
        },
        blocks: [],
      } as unknown as EmbedData;
    },
  }),
}));

import EmbedView from "./EmbedView.js";
import QueryFenceView from "./QueryFenceView.js";
import { BlockContentView, MAX_REF_DEPTH } from "./tokens.js";

afterEach(cleanup);

function hrefOf(content: string, selector: string): string | null | undefined {
  const bc = classifyBlockContent(content);
  const { container } = render(() => <BlockContentView content={bc} ctx={{ source: content }} />);
  return container.querySelector(selector)?.getAttribute("href");
}

describe("page link hrefs keep namespace segments (B-331)", () => {
  it("wikilink", () => {
    expect(hrefOf(`see [[${NAME}]]`, "a.vr-page-ref")).toBe(EXPECTED);
  });

  it("multi-word tag", () => {
    expect(hrefOf(`see #[[${NAME}]]`, "a.vr-tag")).toBe(EXPECTED);
  });

  it("[label]([[page]])", () => {
    expect(hrefOf(`see [the launch]([[${NAME}]])`, "a.vr-page-ref")).toBe(EXPECTED);
  });

  it("a query result's page heading", () => {
    const { container } = render(() => <QueryFenceView code="TODO" ctx={{ source: "" }} />);
    expect(container.querySelector(".vr-query-page a")?.getAttribute("href")).toBe(EXPECTED);
  });

  it("an embed's source line", async () => {
    const { container } = render(() => (
      <EmbedView target={{ kind: "page", name: NAME }} from={0} to={1} ctx={{ source: "" }} />
    ));
    await waitFor(() =>
      expect(container.querySelector("a.vr-embed-source")?.getAttribute("href")).toBe(EXPECTED),
    );
  });

  it("an embed past the depth limit, which shows only a link to its target", () => {
    const { container } = render(() => (
      <EmbedView
        target={{ kind: "page", name: NAME }}
        from={0}
        to={1}
        ctx={{ source: "", refDepth: MAX_REF_DEPTH }}
      />
    ));
    expect(container.querySelector("a.vr-embed-target")?.getAttribute("href")).toBe(EXPECTED);
  });
});
