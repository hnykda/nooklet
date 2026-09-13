/**
 * The status slot client plugins mount into (`registerStatusItem`, ADR 007/023): a strip in the
 * top bar, next to the sync indicator. Host-owned element, plugin-owned contents — a plugin gets an
 * `HTMLElement`, never a component (ADR 007).
 *
 * An item with nothing to say (word count on the journals view) leaves its element empty, and CSS
 * collapses empty items so the bar does not grow a gap.
 */
import type { StatusItemDef } from "@nooklet/plugin-api";
import { createSignal, For, onCleanup, onMount } from "solid-js";
import "./plugins.css";

export interface RegisteredStatusItem {
  pluginId: string;
  item: StatusItemDef;
}

const [items, setItems] = createSignal<readonly RegisteredStatusItem[]>([]);

/** Add an item; the returned function removes exactly that one (its mount is disposed with it). */
export function addStatusItem(entry: RegisteredStatusItem): () => void {
  setItems((prev) => [...prev, entry]);
  return () => setItems((prev) => prev.filter((e) => e !== entry));
}

export function PluginStatusItems() {
  return (
    <div class="app-plugin-status">
      {/* Keyed by reference, and each entry object is created once per registration, so an
          unrelated registration never remounts (and re-fetches) an item that is already up. */}
      <For each={items()}>
        {(entry) => {
          let el!: HTMLSpanElement;
          onMount(() => {
            try {
              const mounted = entry.item.mount(el);
              if (mounted) onCleanup(() => mounted.dispose());
            } catch (e) {
              console.warn(`[plugins] status item "${entry.item.id}" failed to mount:`, e);
            }
          });
          return (
            <span
              ref={el}
              class="app-plugin-status-item"
              data-plugin={entry.pluginId}
              data-status-item={entry.item.id}
            />
          );
        }}
      </For>
    </div>
  );
}
