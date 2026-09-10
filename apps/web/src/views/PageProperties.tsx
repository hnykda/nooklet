/**
 * The page properties panel (BUILD item 2; PLAN.md §8: "the page header shows a properties
 * panel"). Simplification: every property is edited as plain text regardless of its declared type
 * (text/number/date/checkbox/page/url/list, PLAN.md §8) — a typed editor per kind is real editor
 * surface work (date pickers, page-ref autocomplete, etc.) out of this task's scope. Values stay
 * strings on the wire either way (docs/spec/sql-schema.md: "values stay strings"), so this is a
 * display simplification only, not a data-model one. Noted in the task summary.
 */
import { createSignal, For, type JSX } from "solid-js";
import { applyOp } from "../data/store.js";

export interface PagePropertiesProps {
  pageId: string;
  properties: Record<string, string>;
}

function PropertyRow(props: { pageId: string; propKey: string; value: string }): JSX.Element {
  const [draft, setDraft] = createSignal(props.value);
  async function commit(): Promise<void> {
    const value = draft();
    if (value === props.value) return;
    await applyOp(props.pageId, {
      kind: "page.prop",
      key: props.propKey,
      value: value === "" ? null : value,
    });
  }
  return (
    <li class="page-property-row">
      <span class="page-property-key">{props.propKey}</span>
      <input
        class="page-property-value"
        value={draft()}
        onInput={(e) => setDraft(e.currentTarget.value)}
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
      />
    </li>
  );
}

export function PageProperties(props: PagePropertiesProps): JSX.Element {
  const [newKey, setNewKey] = createSignal("");
  const [newValue, setNewValue] = createSignal("");

  async function addProperty(): Promise<void> {
    const key = newKey().trim().toLowerCase().replace(/\s+/g, "-");
    if (!/^[a-z][a-z0-9-]*$/.test(key)) return;
    const value = newValue();
    setNewKey("");
    setNewValue("");
    await applyOp(props.pageId, { kind: "page.prop", key, value });
  }

  return (
    <div class="page-properties">
      <ul class="page-property-list">
        <For each={Object.entries(props.properties)}>
          {([key, value]) => <PropertyRow pageId={props.pageId} propKey={key} value={value} />}
        </For>
      </ul>
      <div class="page-property-add">
        <input
          class="page-property-add-key"
          placeholder="property"
          value={newKey()}
          onInput={(e) => setNewKey(e.currentTarget.value)}
        />
        <input
          class="page-property-add-value"
          placeholder="value"
          value={newValue()}
          onInput={(e) => setNewValue(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void addProperty();
          }}
        />
        <button type="button" onClick={() => void addProperty()}>
          Add
        </button>
      </div>
    </div>
  );
}
