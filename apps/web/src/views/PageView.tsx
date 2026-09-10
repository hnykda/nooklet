/**
 * The page view (BUILD item 2) and, scoped to one block via `rootBlockId`, the zoom view (BUILD
 * item 3). Page title (editable, `page.rename`), properties panel, `BlockTree`, and — only for the
 * full page, not the zoomed-in one — the namespace section and linked/unlinked references below
 * it. Resolves the page by name, case-insensitively (`normalizePageName`, via
 * `../data/store.ts#usePageByName`), since that is what refs navigate to (PLAN.md §4).
 */
import { newId } from "@nooklet/core";
import { useNavigate } from "@solidjs/router";
import { type Accessor, createEffect, createSignal, type JSX, Show } from "solid-js";
import { applyOp, usePageByName, usePageProperties } from "../data/store.js";
import type { NavigateTarget } from "../data/types.js";
import { BlockTree } from "../editor/BlockTree.js";
import { NamespaceChildren } from "./NamespaceChildren.js";
import { goToTarget, pageRoutePath } from "./navigateTarget.js";
import { PageProperties } from "./PageProperties.js";
import { ReferencesPanel } from "./ReferencesPanel.js";
import { ViewNav } from "./ViewNav.js";

export interface PageViewProps {
  name: Accessor<string>;
  /** Present (and non-empty) only on the `?block=` zoom route (BUILD item 3). */
  blockId?: Accessor<string | undefined>;
}

export function PageView(props: PageViewProps): JSX.Element {
  const navigate = useNavigate();
  const onNavigate = (t: NavigateTarget) => void goToTarget(navigate, t);

  const page = usePageByName(props.name);
  const pageId = () => page()?.id;
  const properties = usePageProperties(pageId);
  const blockId = () => props.blockId?.();

  const [titleDraft, setTitleDraft] = createSignal(props.name());
  createEffect(() => {
    const p = page();
    setTitleDraft(p ? p.name : props.name());
  });

  async function commitTitle(): Promise<void> {
    const p = page();
    if (!p) return;
    const value = titleDraft().trim();
    if (value === "" || value === p.name) {
      setTitleDraft(p.name);
      return;
    }
    await applyOp(p.id, { kind: "page.rename", name: value });
  }

  async function createThisPage(): Promise<void> {
    const id = newId();
    await applyOp(id, {
      kind: "page.create",
      name: props.name(),
      journalDay: null,
      createdAt: Date.now(),
    });
  }

  return (
    <div class="page-view">
      <ViewNav />

      <Show when={blockId()}>
        <div class="page-view-breadcrumb">
          <button
            type="button"
            class="page-view-back"
            onClick={() => navigate(pageRoutePath(props.name()))}
          >
            ← {page()?.name ?? props.name()}
          </button>
        </div>
      </Show>

      <Show when={page.loading}>
        <p class="page-view-loading">Loading…</p>
      </Show>

      <Show when={!page.loading && page() === null}>
        <div class="page-view-missing">
          <h1>{props.name()}</h1>
          <p>This page doesn't exist yet.</p>
          <button type="button" onClick={() => void createThisPage()}>
            Create "{props.name()}"
          </button>
        </div>
      </Show>

      <Show when={page()}>
        {(p) => (
          <>
            <input
              class="page-title-input"
              value={titleDraft()}
              onInput={(e) => setTitleDraft(e.currentTarget.value)}
              onBlur={() => void commitTitle()}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
              }}
              aria-label="Page title"
            />
            <PageProperties pageId={p().id} properties={properties()} />
            <BlockTree pageId={p().id} rootBlockId={blockId()} onNavigate={onNavigate} />

            <Show when={!blockId()}>
              <NamespaceChildren name={p().name} onNavigate={onNavigate} />
              <ReferencesPanel target={p().name} onNavigate={onNavigate} />
            </Show>
          </>
        )}
      </Show>
    </div>
  );
}
