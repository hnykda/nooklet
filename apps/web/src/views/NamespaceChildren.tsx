/**
 * The namespace section on a page that is a namespace parent (BUILD item 2; PLAN.md §8: "`A/B/C`
 * ... the page shows its children as a tree ... lists display the short form with the namespace
 * dimmed"). Renders nothing when there are no children — a page only "is a namespace parent" in
 * that it happens to have some.
 */
import { For, type JSX, Show } from "solid-js";
import { useNamespaceChildren } from "../data/store.js";
import type { NavigateTarget } from "../data/types.js";
import { namespaceLabel } from "./namespace.js";

export interface NamespaceChildrenProps {
  name: string;
  onNavigate: (t: NavigateTarget) => void;
}

export function NamespaceChildren(props: NamespaceChildrenProps): JSX.Element {
  const children = useNamespaceChildren(() => props.name);

  return (
    <Show when={children().length > 0}>
      <section class="namespace-children" aria-label="Namespace pages">
        <h3>Pages in this namespace</h3>
        <ul>
          <For each={children()}>
            {(child) => {
              const label = namespaceLabel(child.name);
              // "A/B" under "A" shows dimmed "A/" + short "B"; a deeper child ("A/B/C" under "A")
              // shows its own dimmed parent in full, so nesting depth is still visible at a glance.
              const dimmed = child.name.slice(0, child.name.length - label.short.length);
              return (
                <li>
                  <button
                    type="button"
                    class="namespace-child-link"
                    onClick={() => props.onNavigate({ kind: "page", name: child.name })}
                  >
                    <Show when={dimmed !== ""}>
                      <span class="namespace-child-dimmed">{dimmed}</span>
                    </Show>
                    <span class="namespace-child-short">{label.short}</span>
                  </button>
                </li>
              );
            }}
          </For>
        </ul>
      </section>
    </Show>
  );
}
