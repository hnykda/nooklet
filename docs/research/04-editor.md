# 04 — The block-outliner editor: architecture research

Date: 2026-09-10. Scope: how to build nooklet's block editor for desktop + iOS Safari + Android Chrome with a small team. All package versions below were read from the npm registry on 2026-09-10; measurements were run locally (Node 26.8.1, headless Chrome 153, Apple Silicon Mac) with scripts kept in `scratchpad/bench/`.

---

## 0. Recommendation (one paragraph)

Use the **Logseq/Roam architecture** — every block is rendered HTML, and exactly **one editing surface** exists at a time, mounted into the block being edited — but make that surface a **single, reused CodeMirror 6 `EditorView`** instead of a `<textarea>`. CM6 gives you what the textarea approach lacks (syntax highlighting, Obsidian-style live-preview decorations, a solid autocomplete state machine, caret geometry APIs, IME/composition and Android `beforeinput` handling maintained by one of the few people who fixes mobile contenteditable bugs monthly) while keeping the properties that make the textarea approach robust (one small editable region, everything else is inert DOM, markdown string is the only source of truth, no lossy round-trip). Obsidian has shipped this exact editor on iOS/Android since 2021-22. Keep the surface behind a ~10-method `Surface` interface so a plain-textarea fallback (~300 lines) can be swapped in if a device class misbehaves. Do **not** build on ProseMirror/Tiptap/BlockNote/Lexical/Slate: they force a rich-text document model with lossy markdown round-tripping and they are still shipping Android/IME workarounds every month in 2026 (see §2.4). Around the surface: a hand-written inline tokenizer for our block grammar (0.6 µs/block — 7x faster than markdown-it, 50x faster than micromark), SolidJS for the rendering tree, `content-visibility: auto` first and TanStack Virtual only if needed, and a CRDT undo manager (Yjs or Loro) as the single undo stack for text + structure.

---

## 1. How the incumbents do it (evidence)

### 1.1 Logseq (file version and the 2026 "DB"/2.0 version) — `<textarea>` per editing block

Source read on 2026-09-10 from `master` (which is the DB version; 2.0 beta shipped 2026-07-13, https://news.ycombinator.com/item?id=48896229):

- **Editing surface**: `ui/ls-textarea` in `src/main/frontend/ui.cljs` wraps `react-textarea-autosize`. Rendered into `.editor-inner` from `src/main/frontend/components/editor.cljs` with `on-change`, `on-key-down`, `on-key-up`, `on-paste`, `on-click` handlers. https://github.com/logseq/logseq/blob/master/src/main/frontend/components/editor.cljs
- **IME safety**: `ls-textarea` attaches `on-composition-start/update/end`; `compositionend` sets `state/set-editor-in-composition! false` and only then calls `on-change`. `on-change` is wrapped as `(when-not (state/editor-in-composition?) (on-change e))`. Key handlers check `editor-in-composition?` before acting. That is the whole IME strategy — and it works because a textarea's composition is handled natively by the browser.
- **Autocomplete triggers** live in the **keyup** handler (`keyup-handler` in `handler/editor.cljs`): it looks at `last-input-char` (`[[`, `((`, `#`, `/`), checks `start-of-new-word?`, stores `(state/set-editor-action-data! {:pos (cursor/get-caret-pos input)})` and opens the popup. Popup position comes from `cursor/get-caret-pos`, which reads coordinates from a **"mock-text" mirror element** (a hidden div that mirrors the textarea's text with one span per character) — the classic `textarea-caret` trick (npm `textarea-caret` 3.1.0, last published 2022).
- **Up/Down between blocks**: `util/cursor.cljs` — `textarea-cursor-first-row?` / `textarea-cursor-last-row?` compare the caret's `top` (from the mirror) with the first/last distinct row `top`; `move-cursor-up/down` pick the nearest character by `left` on the adjacent row. Cross-block moves save the position (`state/set-editor-last-pos!`) and restore with `cursor/move-cursor-to` = `setSelectionRange`. https://github.com/logseq/logseq/blob/master/src/main/frontend/util/cursor.cljs
- **Click on a rendered block**: `block-content-on-pointer-down` grabs `(util/caret-range node)` from the rendered DOM and `diff/find-position markup cursor-range` diffs rendered text vs. source markup to find the source offset. Heuristic; it's the origin of several "cursor lands in the wrong place" issues.
- **Enter**: `insert-new-block!` → `compute-fst-snd-block-text value selection-start selection-end` splits at the caret; `outliner-insert-block!` inserts a sibling; `inserted-block-edit-fn` focuses the new block.
- **Backspace at 0**: `delete-block-inner!` → `delete-block-with-previous!` merges and edits the previous block with caret at its old length.
- **Tab / Shift-Tab**: `on-tab` → `indent-outdent-blocks!`; the textarea is **unmounted and remounted**, `restore-cursor-pos!` puts the caret back. This is the source of the "block jumps when indenting" issues (https://github.com/logseq/logseq/issues/6030).
- **Shift+Up/Down**: `select-block-up-down` saves the block, exits editing, and puts the block into selection mode (`exit-editing-and-set-selected-blocks!`); further Shift+arrows extend with `conj-selection-block!`.
- **Paste**: multi-line text is parsed into blocks and inserted with `outliner-op/insert-blocks! ... {:sibling? true}`; `edit-last-block-after-inserted!` focuses the last one.
- **Long pages**: no virtualization; blocks are wrapped in `ui/lazy-visible` (IntersectionObserver placeholders) — `frontend/components/block.cljs`.
- **Mobile keyboard (2026)**: Logseq gave up on a web toolbar. `ios/App/App/NativeEditorToolbarPlugin.swift` and `android/.../NativeEditorToolbarPlugin.kt` are Capacitor plugins that draw a **native** accessory bar (UIVisualEffectView blur, horizontally scrolling UIStackView of actions, a trailing "done" action). The web side registers it in `src/main/frontend/mobile/util.cljs` (`registerPlugin "NativeEditorToolbarPlugin"`, plus a `NativeSelectionActionBarPlugin`). `handler/events.cljs` handles `:mobile/keyboard-will-show [height]` by setting `--ls-native-kb-height` on `:root`, adding class `has-mobile-keyboard`, then `scroll-editor-cursor`. There is also `WebViewKeyboardRecovery.kt`: "on some Android/WebView combinations, focusing an input while the IME is shown can leave the native WebView host chain panned/resized after the IME hides" — they reset native view state after keyboard hide. And `mobile-focus-hidden-input`: focus a hidden `#ls-mobile-kb-anchor` input inside the tap gesture and blur it 200 ms later, to keep the iOS keyboard open while the real editor mounts.
- Known UX complaints that are structural to the textarea approach: no formatting while editing (https://discuss.logseq.com/t/how-to-make-block-display-same-in-editing-mode-and-view-mode/18285), layout shift when entering edit mode, mouse selection across rendered blocks (https://github.com/logseq/logseq/issues/5478), autocomplete edge cases (https://github.com/logseq/logseq/issues/6126, https://github.com/logseq/logseq/issues/6805).

### 1.2 Roam, Workflowy, Dynalist, Tana

- **Roam Research**: same architecture — the editing block is a `<textarea class="rm-block-input">` (auto-sized), everything else is rendered `.roam-block`. Evidence: roam-toolkit's selectors (`blockInput: '.rm-block-input'`) and `dom.ts` selecting `` `${Selectors.block}, textarea` `` for "current block" (https://github.com/roam-unofficial/roam-toolkit/blob/master/src/ts/core/roam/selectors.ts). Athens Research (ClojureScript Roam clone) did the same.
- **Workflowy**: per-node `contenteditable` (`.name .content` — see rawbytz's bookmarklets targeting `.name .content`, https://github.com/rawbytz/focus-fix). Workflowy's nodes are rich text (bold/italic/links stored as HTML), not markdown, so contenteditable is the natural fit; they accept the browser-quirk maintenance. On mobile their apps put an accessory bar above the keyboard with `@`, tag, link and mirror buttons, with "[[" typing as the alternative (https://workflowy.com/help/add-edit-format/, https://blog.workflowy.com/updated-design-for-creating-new-pages-via/). What makes it feel native: zero layout shift between "viewing" and "editing" a node (there is no mode switch — every node is always a contenteditable), large tap targets, the accessory bar, and no visible re-render when the keyboard opens.
- **Dynalist**: not verified in this pass (search budget exhausted); treat as unknown.
- **Tana**: iOS app Nov 2024, Android Feb 2025, full editing of all notes in 2025 (https://tana.inc/articles/whats-new-in-tana-2025-product-updates). Their editor technology is not public; not verified.

### 1.3 The CodeMirror 6 camp: Obsidian, SilverBullet, Atomic Editor

- **Obsidian** runs CM6 on **all platforms**; mobile got CM6 *before* desktop (joethei, Obsidian team, 2022-06-08: "Obsidian uses CM6 on all platforms" — https://news.ycombinator.com/item?id=31669303). Live Preview = CM6 decorations that hide markdown syntax except around the cursor. This is the strongest available evidence that CM6 is viable for a mass-market mobile markdown editor.
- **SilverBullet** (TypeScript, CM6 for the whole page, Preact UI, PWA): https://silverbullet.md/PWA. Their mobile issue is about the keyboard popping up on every tap (issue #704 https://github.com/silverbulletmd/silverbullet/issues/704) — a consequence of having one giant editable page; the one-block-editable design avoids it.
- **Atomic Editor** (`@atomic-editor/editor`, MIT, https://github.com/kenforthewin/atomic-editor, Show HN ~June 2026 https://news.ycombinator.com/item?id=48345201): Obsidian-style live preview as CM6 ViewPlugins + decorations, with `[[target|label]]` wikilinks + autocomplete, tables, lazy-loaded code-fence highlighting, task lists, and explicit "iOS-aware" fixes (momentum-scroll halts, heightmap drift). The author chose CM6 over ProseMirror because CM6 virtualizes long documents natively. Useful as a reference implementation of the decoration approach, not as a dependency (young, single maintainer, some reported instability).

---

## 2. Approach evaluation

### 2.1 Measured numbers

Bundle sizes — esbuild `--bundle --minify --format=esm`, brotli `-q 11`, gzip `-9` (script: `scratchpad/bench/`):

| Bundle | min | gzip | brotli |
|---|---|---|---|
| CM6 core: `@codemirror/state` 6.7.4 + `view` 6.43.11 + `commands` defaultKeymap + lineWrapping | 266 kB | 86.6 kB | **75.4 kB** |
| + `@codemirror/lang-markdown` 6.5.2 (`@lezer/markdown` 1.7.2) | 496 kB | 171 kB | 146 kB |
| + history, drawSelection, placeholder, `@codemirror/autocomplete` 6.20.3 | 536 kB | 184 kB | 157 kB |
| ProseMirror core (model 1.25.11 / state / view 1.42.3 / keymap / commands / history / inputrules) | 208 kB | 64 kB | 56 kB |
| Lexical 0.50.0 + rich-text + list + history | 339 kB | 111 kB | 93 kB |
| micromark 4.0.2 → HTML | 53 kB | 15.4 kB | 13.7 kB |
| micromark + micromark-extension-gfm 3.0.0 | 74 kB | 21.0 kB | 18.6 kB |
| mdast-util-from-markdown 2.0.3 + to-hast 13.2.1 + hast-util-to-html 9.0.5 | 106 kB | 32.2 kB | 28.6 kB |
| markdown-it 15.0.1 | 99 kB | 40.5 kB | 36.4 kB |

Parse speed on a realistic outliner corpus (10 block shapes: wikilinks, tags, block refs, properties, a code fence, CJK, a 300-char block; 20,000 blocks, best of 3):

| Parser | per block |
|---|---|
| micromark → HTML | 29.5 µs |
| mdast-util-from-markdown (AST only) | 26.8 µs |
| markdown-it `.render` | 4.4 µs |
| markdown-it `.parseInline` | 2.9 µs |
| hand-written inline tokenizer (wikilink/blockref/tag/code/bold/link, ~40 lines) | **0.6 µs** |

So a 5,000-block page costs ~150 ms with micromark, ~22 ms with markdown-it, ~3 ms with our own tokenizer — before DOM creation, which dominates anyway. (The MeasureThat.net numbers people quote — markdown-it ~14x faster than micromark — match: https://www.measurethat.net/Benchmarks/Show/16035/0/micromark-vs-markdown-it-parser; micromark's author says it will never match markdown-it's raw speed because it prioritises spec compliance and positional tokens: https://github.com/orgs/micromark/discussions/29.)

Cost of "one CM6 instance per block, mounted on demand" (headless Chrome 153, real DOM, 360 px wide host, markdown + autocomplete + history extensions):

| Operation | time |
|---|---|
| `EditorState.create` with markdown language (Node) | 14 µs |
| `new EditorView(...)` + `coordsAtPos` + `destroy()` | **0.26 ms** |
| `new EditorView` + `focus()` + `destroy()` (markdown only) | 0.17 ms |
| reuse one view: `setState(newState)` + `coordsAtPos` | 0.17 ms |
| reuse one view: `dispatch` replace-all | 0.07 ms |
| `<textarea>`: set value + focus + `setSelectionRange` | 0.02 ms |

Even at 10x on a mid-range phone this is ~3 ms per block switch — invisible. Mount cost is not a reason to avoid CM6; bundle size (+75 kB brotli core, +70 kB if you add the markdown language pack) is the only real price.

### 2.2 Approach 1 — Logseq-style `<textarea>`

Pros: smallest, zero-dependency, the browser owns composition/IME/autocorrect/selection, proven on mobile by Logseq and Roam, no lossy conversion, trivial paste handling.
Cons (all structural, all visible in Logseq's issue tracker): raw markdown while editing; a mirror div hack for every caret-geometry question (popup position, first/last visual row, goal column); auto-grow needs `react-textarea-autosize`-style measurement (CSS `field-sizing: content` is Chromium-only as of 2026); layout shift between rendered and raw text; you re-implement autocomplete UI, bracket auto-pairing, Android `beforeinput` synthesis, and the undo grouping yourself.
Verdict: right **architecture** (one editable region, everything else inert) — wrong **surface** for a product that wants to feel better than Logseq.

### 2.3 Approach 2 — CodeMirror 6 as the editing surface (one instance, mounted into the active block)

What you get for 75–157 kB brotli:
- Composition/IME handled in the view (`DOMObserver`, composition lifecycle, "Process" key 229 ignored); Android/iOS `beforeinput` synthesis: `@codemirror/view` maps `insertParagraph`/`insertLineBreak` → Enter, `deleteContentBackward` → Backspace, `deleteContentForward` → Delete (`PendingKeys` in `view/dist/index.js`), so a normal `keymap` binding for Enter/Backspace works with Gboard, which does not send real key events.
- Actively maintained mobile behaviour — 2025-26 changelog entries (https://codemirror.net/docs/changelog/): 6.43.11 (2026-09-03) "Speed up handling of Enter/Backspace on iOS"; 6.43.8 (2026-08-04) Android/iOS scroll-into-view fix; 6.43.2 (2026-06-23) iOS autocapitalize + shift on Enter/Backspace; 6.39.15 (2026-02-20) Chrome Android scroll fix; 6.38.5 (2025-10-07) Safari 26 focus-scroll workaround; 6.38.4 (2025-09-28) Chrome Android missing `compositionend` workaround; 6.36.2 (2025-01-09) mobile spacebar-drag selection.
- Caret geometry: `coordsAtPos`, `posAtCoords`, `lineBlockAt`, `moveVertically` — exactly what Logseq builds a mirror div for.
- `@codemirror/autocomplete`: sources with `matchBefore(/\[\[[^\]]*$/)`, keyboard navigation, positioning, `closeBrackets()` for `[[`→`[[]]`.
- Decorations (`mark` / `widget` / `replace`) for live preview: hide `**`, show checkbox widgets, style wikilinks, all while the underlying string stays markdown. Reference implementations: Obsidian, Atomic Editor.
- Line wrapping, placeholder, `EditorView.contentAttributes` to turn autocorrect/autocapitalize/spellcheck **on** (CM6 defaults them off for code: `spellcheck:"false", autocorrect:"off", autocapitalize:"off"`), `enterkeyhint`.
- Bindings to CRDTs exist: `y-codemirror.next` 0.3.6 (Yjs), `loro-codemirror` 0.3.3 (Loro, 2025-10).
Cons: it is a code editor at heart — you must theme away monospace/gutters/`.cm-line` padding so the rendered block and the editing block have identical metrics; the built-in completion tooltip is desktop-oriented (fine, but on phones you may render your own list from `currentCompletions`); +75–157 kB brotli; Enter-continues-list behaviours from `lang-markdown` must be replaced by our block-split command (`Prec.highest`).
Verdict: **recommended.**

### 2.4 Approach 3 — ProseMirror / Tiptap / BlockNote / Milkdown

Versions: prosemirror-view 1.42.3 (2026-08-25), @tiptap/core 3.31.3, @blocknote/core 0.54.2 (2026-09-09), @milkdown/core 7.22.1. Note: the ProseMirror GitHub org was archived on 2026-04-07 and development moved to https://code.haverbeke.berlin/prosemirror/prosemirror (npm releases continue).

How bad is contenteditable on mobile in 2026? Better than 2020, still a monthly workaround stream: prosemirror-view 1.42.2 (2026-07-24) "workaround for backspace not taking effect on Android for Firefox as well as Chrome"; 1.41.9 (2026-06-10) "Chrome no longer fires key events for backspace during composition"; 1.41.5 (2026-01-14) "Chrome misreports the cursor position and breaks composition" (https://prosemirror.net/docs/changelog/). The canonical thread "Contenteditable on Android is the Absolute Worst" (https://discuss.prosemirror.net/t/contenteditable-on-android-is-the-absolute-worst/3810) lists the failure classes: no key info from Gboard, composition text-node swaps that delete and re-insert neighbouring text, `contenteditable=false` islands dismissing the keyboard, per-keyboard-vendor quirks. Marijn's mitigation (composition events + `inputType` + DOM observer) is the same machinery as CM6 — but ProseMirror has to apply it across a *whole rich-text document* with nested nodes, marks and NodeViews, while CM6 applies it to flat text with decorations. That is why CM6 has fewer mobile bugs per feature.

The deeper problem for nooklet is the **document model**: PM/Tiptap/BlockNote store a rich-text tree; markdown is an import/export format. `prosemirror-markdown` (1.13.7) round-trips CommonMark but not `[[wikilinks]]`, `((refs))`, `key:: value`, `{{embed}}` unless you write node specs + serializers for each, and any construct you did not model becomes plain text or is dropped. BlockNote is React-only and defines its own JSON block schema (markdown export is explicitly lossy). Milkdown is markdown-first (remark AST ⇄ PM) but inherits PM mobile behaviour and has the same "unknown syntax is lost" issue. For an app whose API/MCP surface *is* markdown strings, this is the wrong shape.

Verdict: no — unless the product pivots to rich-text blocks with markdown as a secondary format.

### 2.5 Approach 4 — brief

| Library | Version | Notes |
|---|---|---|
| Lexical (Meta) | 0.50.0 (2026-09-10) | contenteditable, framework-agnostic core + React bindings; still fixing IME issues in 2026 (#8098 Jan 2026 CJK format inheritance; #6354 Android node-boundary merge; changelog "Fix selected text not properly deleted after IME input on Safari"). Rich-text model; markdown via `@lexical/markdown` transformers (lossy). No. |
| Slate | 0.126.2 | contenteditable; has a dedicated `android-input-manager` (beforeinput + MutationObserver reconciliation) since 0.6x, still the most fragile of the group on Android historically. No. |
| BlockSuite (AFFiNE) | `@blocksuite/affine` 0.22.4, last publish 2025-07-01; `@blocksuite/blocks` 0.19.5 (2025-06) | Yjs-native block editor + whiteboard, Lit-based; publishing stalled for over a year and it is effectively AFFiNE-internal. Heavy. No. |
| Milkdown | 7.22.1 | PM + remark, plugin-heavy; see §2.4. |
| Editor.js | 2.31.6 (2026-04) | contenteditable per block, JSON output, no markdown model, no nesting/outliner semantics. No. |

### 2.6 Approach 5 — custom contenteditable per block

No. You would re-implement CM6's `DOMObserver`, composition tracking and Android `beforeinput` synthesis; that code is 10 years of bug reports.

### 2.7 Decision

Approach 1's architecture with Approach 2's surface. The rest of this document is the design.

---

## 3. Recommended architecture

### 3.1 Data model and view model

```ts
// Persistent model (whatever the sync/storage report decides; this is what the editor needs)
type BlockId = string;                       // uuid
interface Block {
  id: BlockId;
  pageId: string;
  parentId: BlockId | null;                  // null = top level of page
  order: string;                             // fractional index among siblings
  content: string;                           // markdown, the only source of truth
  collapsed: boolean;
  props?: Record<string, string>;            // parsed from `key:: value` lines, derived
}

// View model: the page tree flattened to visible rows (respects collapsed, zoom root)
interface Row { id: BlockId; depth: number; hasChildren: boolean; collapsed: boolean; }
// rows() is a memo over (blocks, collapsed set, zoomRoot). Cheap: O(visible).
```

Flattening is what makes virtualization, keyboard navigation (prev/next visible block) and multi-select trivial: they are all index arithmetic on `rows`.

### 3.2 Component structure (SolidJS)

```tsx
// Outliner.tsx — owns: rows memo, selection state, editing state, the Surface, the key dispatcher
export function Outliner(props: { pageId: string; zoomRoot?: BlockId }) {
  const rows = createMemo(() => flatten(store, props.pageId, props.zoomRoot));
  const [editing, setEditing] = createSignal<{ id: BlockId } | null>(null);
  const [selection, setSelection] = createSignal<Set<BlockId>>(new Set());
  const surface = createSurface({ /* CM6 instance, created once */ commands, getCtx });

  return (
    <div class="outliner" role="tree" onKeyDown={e => dispatchSelectionKeys(e, ...)}>
      <For each={rows()}>{row => (
        <BlockRow row={row}
                  editing={() => editing()?.id === row.id}
                  selected={() => selection().has(row.id)}
                  surface={surface} />
      )}</For>
    </div>
  );
}

// BlockRow.tsx — pure presentation, no editor logic
function BlockRow(props) {
  const block = () => store.blocks[props.row.id];                 // fine-grained: only this row re-runs on content change
  const tokens = createMemo(() => tokenizeBlock(block().content)); // §4
  return (
    <div class="row" classList={{ selected: props.selected(), editing: props.editing() }}
         style={{ "--depth": props.row.depth }} data-block-id={props.row.id}>
      <Bullet collapsed={props.row.collapsed} hasChildren={props.row.hasChildren} />
      <div class="content">
        <Show when={props.editing()} fallback={<BlockView tokens={tokens()} />}>
          <div class="surface-host" ref={el => props.surface.attach(el, props.row.id)} />
        </Show>
      </div>
    </div>
  );
}
```

Rules that keep this fast and jank-free:
- `BlockView` and the CM6 content share one CSS ruleset for font, size, line-height, padding (`.cm-content, .cm-line { padding: 0; font: inherit; }`, `.cm-editor { background: transparent }`, no gutters, `EditorView.lineWrapping`). Switching modes must not move text by a pixel.
- Indentation via `padding-left: calc(var(--depth) * 1.5rem)` on the flat row, not nested DOM. Nested DOM makes virtualization and drag reordering much harder and gives no benefit.
- The editing row is always rendered even if the virtualizer would drop it (pin it).

### 3.3 The single editing surface

```ts
interface Surface {
  attach(host: HTMLElement, id: BlockId, caret?: CaretSpec): void;  // mounts into host, focuses, sets caret
  detach(): { id: BlockId; content: string; head: number } | null;    // commits and unmounts
  content(): string; head(): number; anchor(): number;
  isComposing(): boolean;
  geometry(): { atStart; atEnd; onFirstLine; onLastLine; goalX: number };
  setCaret(spec: CaretSpec): void;
}
type CaretSpec = { at: 'start' } | { at: 'end' } | { offset: number } | { goalX: number; line: 'first' | 'last' };
```

CM6 implementation, key points:

```ts
import { EditorState, Prec, Compartment } from "@codemirror/state";
import { EditorView, keymap, placeholder } from "@codemirror/view";
import { defaultKeymap } from "@codemirror/commands";
import { autocompletion, closeBrackets } from "@codemirror/autocomplete";

const baseExtensions = [
  Prec.highest(keymap.of(outlinerKeymap)),            // §3.4 — beats defaultKeymap and autocomplete's keymap
  keymap.of(defaultKeymap),                           // no history(): undo comes from the doc-level manager (§7)
  EditorView.lineWrapping,
  EditorView.contentAttributes.of({
    spellcheck: "true", autocorrect: "on", autocapitalize: "sentences",
    enterkeyhint: "enter", "aria-label": "Block content",
  }),
  autocompletion({ override: [pageSource, tagSource, blockRefSource, slashSource],
                   activateOnTyping: true, interactionDelay: 0, icons: false }),
  closeBrackets(),                                    // "[" -> "[]", second "[" -> "[[]]"; "(" likewise; "`"
  livePreview(tokenizeBlock),                         // §3.6
  EditorView.theme({ "&": { font: "inherit" }, ".cm-content": { padding: 0 }, ".cm-line": { padding: 0 } }),
];

export function createSurface(deps): Surface {
  const view = new EditorView({ state: EditorState.create({ doc: "", extensions: baseExtensions }) });
  let current: BlockId | null = null;

  return {
    attach(host, id, caret = { at: "end" }) {
      if (current) this.detach();
      current = id;
      view.setState(EditorState.create({ doc: deps.getContent(id), extensions: baseExtensions })); // 0.17 ms
      host.appendChild(view.dom);
      view.focus();                       // must run synchronously inside the user gesture on iOS
      this.setCaret(caret);
      view.dispatch({ effects: EditorView.scrollIntoView(view.state.selection.main.head, { y: "nearest", yMargin: 64 }) });
    },
    detach() {
      if (!current) return null;
      const out = { id: current, content: view.state.doc.toString(), head: view.state.selection.main.head };
      deps.commit(out);                   // last flush; live edits are already streamed via updateListener/CRDT binding
      view.dom.remove(); current = null;
      return out;
    },
    isComposing: () => view.composing,
    geometry() {
      const { head } = view.state.selection.main, doc = view.state.doc;
      const c = view.coordsAtPos(head), first = view.coordsAtPos(0), last = view.coordsAtPos(doc.length);
      return {
        atStart: head === 0, atEnd: head === doc.length,
        onFirstLine: !c || !first || Math.abs(c.top - first.top) < 2,
        onLastLine: !c || !last || Math.abs(c.top - last.top) < 2,
        goalX: c ? c.left : 0,
      };
    },
    setCaret(spec) {
      const doc = view.state.doc; let pos: number;
      if (spec.at === "start") pos = 0;
      else if (spec.at === "end") pos = doc.length;
      else if ("offset" in spec) pos = Math.min(spec.offset, doc.length);
      else { // goalX on first/last visual line: needs layout, host is attached so this is fine
        const y = view.coordsAtPos(spec.line === "first" ? 0 : doc.length)!;
        pos = view.posAtCoords({ x: spec.goalX, y: (y.top + y.bottom) / 2 }) ?? (spec.line === "first" ? 0 : doc.length);
      }
      view.dispatch({ selection: { anchor: pos } });
    },
    content: () => view.state.doc.toString(), head: () => view.state.selection.main.head, anchor: () => view.state.selection.main.anchor,
  };
}
```

Why one reused instance instead of one per block: stable memory, no extension re-instantiation, and — decisive on iOS — the keyboard stays open across block switches only if the next focus happens synchronously in the same gesture; a reused, already-configured view makes that trivially true. (Creating per block would also work at 0.26 ms; reuse is simply simpler to keep correct.)

Click on a rendered block → caret at the clicked character: `BlockView` renders every token as an element with `data-from`/`data-to` source offsets (our tokenizer emits offsets). On `pointerdown`, `document.caretPositionFromPoint(x, y)` (Safari uses `caretRangeFromPoint`) gives a text node + offset; walk up to the nearest `[data-from]`, source offset = `from + offsetWithinTextNode` (for tokens whose rendered text equals their source text; for hidden-marker tokens like `**bold**`, add the marker length). Deterministic, unlike Logseq's `diff/find-position`.

Streaming edits: `EditorView.updateListener` (or the CRDT binding, §7) writes content changes to the store on every transaction, so BlockView for *other* consumers (backlinks panel, search) is always current and nothing is lost on a crash. Debounce persistence, not the store.

### 3.4 Keydown handler contract

The outliner keymap runs at `Prec.highest` inside CM6 (so it sees keys before default commands and before the autocomplete keymap), and a parallel `keydown` listener on the outliner container handles selection-mode keys when no surface is mounted. Every command receives one `Ctx`:

```ts
interface Ctx {
  id: BlockId; row: number;                    // index into rows()
  text: string; head: number; anchor: number;  // from Surface
  atStart: boolean; atEnd: boolean; onFirstLine: boolean; onLastLine: boolean; goalX: number;
  composing: boolean;                          // Surface.isComposing() || ev.isComposing || ev.keyCode === 229
  popupOpen: boolean;                          // completionStatus(state) === 'active'
  mobile: boolean;
}
type Cmd = (ctx: Ctx) => boolean;              // true → handled, preventDefault; false → fall through
```

Contract (order matters; first `true` wins):

| Key | Guard | Command | Effect on surface / focus |
|---|---|---|---|
| any | `composing` | return false | never touch the doc during IME composition |
| Esc / Enter / Up / Down / Tab | `popupOpen` | let autocomplete keymap handle | (our keymap returns false when `popupOpen`) |
| Enter | — | `splitBlock(id, head)` (text after caret → new sibling; if block has children and is expanded → new first child) | detach → attach(new, `{at:'start'}`) |
| Shift+Enter | — | insert `\n` in block | none |
| Mod+Enter | — | toggle TODO/checkbox state | none |
| Backspace | `atStart && anchor===head` | if `text===''` → `deleteBlock` and edit previous at end; else `mergeIntoPrevious` (prev.content += text; caret = prev old length) | attach(prev, `{offset}`) |
| Delete | `atEnd` | `mergeNextIntoThis` | caret unchanged |
| Tab | — | `indent([id])` (no-op if no previous sibling) | **keep the surface mounted**: the row DOM stays, only `--depth` changes; no caret restore needed |
| Shift+Tab | — | `outdent([id])` | same |
| Up | `onFirstLine` | edit previous visible row with `{goalX, line:'last'}` | attach(prev) |
| Down | `onLastLine` | edit next visible row with `{goalX, line:'first'}` | attach(next) |
| Left | `atStart` | edit previous row `{at:'end'}` | attach(prev) |
| Right | `atEnd` | edit next row `{at:'start'}` | attach(next) |
| Alt+Up / Alt+Down (Mod+Shift+Up/Down on mac) | — | `moveUp/Down([id])` among siblings | surface stays mounted (row moves in the flat list; Solid keyed `<For>` moves the DOM node; CM6 tolerates re-parenting) |
| Shift+Up / Shift+Down | — | detach → selection mode with `{id}`; subsequent Shift+arrows extend | focus moves to the outliner container (`tabindex=-1`) |
| Esc | — | detach → select current block | container focused |
| Mod+Up / Mod+Down | — | collapse / expand | none |
| Mod+Shift+A (or Alt+Enter) | — | zoom into block | route change |
| Mod+Z / Mod+Shift+Z | — | undo/redo via doc-level manager (§7) | may re-attach a surface |
| `[[`, `((`, `#`, `/` | typed (not keydown) | handled by autocomplete sources' `matchBefore`; nothing in keymap | — |

Selection-mode keys (no surface): Up/Down move the anchor, Shift+Up/Down extend, Tab/Shift+Tab indent/outdent the selection, Backspace/Delete delete, Enter edits the anchor block at end, Mod+C copies the selection as nested markdown, Esc clears, Mod+A selects all visible rows.

Mobile: Tab/Shift+Tab/Alt+arrows have no keys → toolbar buttons call the same commands with the same `Ctx` (§8).

All structural commands are pure functions over the store that return a transaction (list of ops + inverse), so the same code runs from keyboard, toolbar, drag/drop, undo, and the HTTP API.

### 3.5 Autocomplete (`[[`, `#`, `((`, `/`)

```ts
import { CompletionContext, CompletionResult } from "@codemirror/autocomplete";

const pageSource = async (cx: CompletionContext): Promise<CompletionResult | null> => {
  const m = cx.matchBefore(/\[\[([^\]\n]*)$/);           // also handles the "[[]]" closeBrackets case
  if (!m) return null;
  const q = m.text.slice(2);
  const pages = await index.searchPages(q, 12);          // local index; async is fine, CM6 cancels stale results
  return {
    from: m.from + 2, to: cx.pos,
    filter: false,                                       // we already ranked
    options: [
      ...pages.map(p => ({ label: p.title, apply: (v, _c, from, to) => applyLink(v, from, to, p.title) })),
      ...(q && !pages.some(p => p.title.toLowerCase() === q.toLowerCase())
          ? [{ label: `Create "${q}"`, apply: (v, _c, from, to) => applyLink(v, from, to, q) }] : []),
    ],
  };
};
function applyLink(view, from, to, title) {
  const after = view.state.doc.sliceString(to, to + 2) === "]]" ? to + 2 : to;   // consume auto-paired "]]"
  view.dispatch({ changes: { from, to: after, insert: `${title}]]` }, selection: { anchor: from + title.length + 2 } });
}
// tagSource: matchBefore(/(^|\s)#([^\s#]*)$/) → inserts `#tag` or `#[[multi word]]`
// blockRefSource: matchBefore(/\(\(([^)\n]*)$/) → full-text search over blocks, inserts ((uuid)), shows block text + page
// slashSource: matchBefore(/(^|\s)\/([\w-]*)$/) → commands: todo, date, heading, code fence, embed, property…
```

The built-in tooltip is positioned by CM6 (`tooltips({ parent: document.body, position: 'fixed' })` so it escapes overflow clipping). On phones, consider rendering your own list from `currentCompletions(state)` + `completionStatus(state)` as a sheet above the keyboard, keeping CM6's filtering/selection state machine; start with the built-in tooltip and measure.

### 3.6 Live preview decorations (Obsidian-style)

A `ViewPlugin` that runs our tokenizer on the block text, and for each token emits: `Decoration.mark({class})` on the token span; `Decoration.replace({})` on syntax markers (`**`, `` ` ``, `[[`/`]]`, link URL part) **unless** the selection head is inside or adjacent to the token (then show raw); `Decoration.widget` for checkboxes (`- [ ]`/`TODO`) and for `((uuid))` → inline preview text. Because a block is short, recompute on every transaction (`update.docChanged || update.selectionSet`) — sub-millisecond. This is exactly what Atomic Editor does; read its source for the cursor-adjacency and atomic-range details (`EditorView.atomicRanges` so arrow keys skip hidden markers). Clickable links inside the editor: use `EditorView.domEventHandlers({ mousedown })` with modifier check; on touch, a tap on a wikilink while editing navigates only via long-press/menu to avoid accidental navigation.

`@codemirror/lang-markdown` is optional. Phase 1 can ship without it (our tokenizer drives all decorations; code fences are plain while editing and shiki-highlighted in view mode) and save ~70 kB brotli. Add it later if you want in-editor code highlighting: `markdown({ codeLanguages: languages })` with `@codemirror/language-data` lazy-loading modes, and add our inline constructs as Lezer `MarkdownConfig.parseInline` extensions (https://github.com/lezer-parser/markdown#user-content-markdownconfig) so highlighting comes from one tree. Do **not** use its `insertNewlineContinueMarkup` keymap; our Enter splits blocks.

### 3.7 Paste

`EditorView.domEventHandlers({ paste })`: read `text/plain`. If it contains a newline: run `parseOutline(text)` — split lines, compute depth from leading spaces/tabs and list markers (`-`, `*`, `+`, `1.`), treat fenced code blocks as one block, collapse blank-line-separated paragraphs into blocks — and `insertBlocks(afterId, tree)` as siblings (Logseq's `:sibling? true`), then edit the last inserted block at end. If the current block is empty, replace it with the first pasted block. Single-line paste → let CM6 insert. `text/html` from browsers → optional later step with a small HTML→markdown pass (turndown, 20 kB) behind a "paste as markdown" toggle. Images in the clipboard → upload, insert `![](asset)`.

### 3.8 Selection mode, drag handle

Selection mode is a set of block ids + anchor, rendered as `.row.selected` with `user-select: none` on the outliner; copy produces nested markdown (`- text\n  - child`). Drag handle (nice-to-have): show on hover/long-press, use `@atlaskit/pragmatic-drag-and-drop` 3.1.0 (framework-agnostic, pointer-based, works on touch; `@dnd-kit/core` 6.3.1 has not been published since 2024-12) — drop indicator computed from pointer x (depth) and y (row), then `moveBlocks(ids, {parentId, afterId})`.

### 3.9 Zoom (block as page)

Zoom is just `zoomRoot` in `flatten()` plus a breadcrumb; the surface and commands are unchanged. Outdent at zoom root is a no-op; Backspace on the first row at start is a no-op.

---

## 4. Markdown parsing per block

### 4.1 Options

- **micromark 4.0.2 / mdast-util-from-markdown 2.0.3 (remark)**: most correct, positional tokens, big extension ecosystem — but slowest (27–30 µs/block) and the wikilink extensions are stale: `micromark-extension-wiki-link` 0.0.4 (2022-05, depends on `@babel/runtime`, micromark-2 era API, https://github.com/landakram/micromark-extension-wiki-link), `remark-wiki-link` 2.0.1 (2023-10) and `mdast-util-wiki-link` 0.1.2 (depends on `mdast-util-to-markdown ^0.6`, i.e. pre-ESM) — expect to fork. Newer: `@moritzrs/micromark-extension-ofm-wikilink` 0.0.1 (2024-11, Obsidian-flavoured, with `remark-ofm`), and `micromark-extension-cjk-friendly` 2.0.1 (2026-02) for CJK emphasis. No extensions exist for `((uuid))`, `{{embed}}`, `key:: value` — you would write three micromark extensions (tokenizer state machines; not trivial).
- **markdown-it 15.0.1**: 4.4 µs/block, plugins are simple inline rules (a `[[` rule is ~30 lines), mature, but its output is HTML strings or a flat token stream; integrating with a component renderer means walking its token array. Reasonable fallback.
- **Hand-written tokenizer for our grammar**: 0.6 µs/block, produces offset-annotated tokens that serve three consumers with one grammar: `BlockView` rendering, CM6 live-preview decorations (need offsets), and the server/MCP (link/tag/ref extraction for the backlink index). Logseq (mldoc, OCaml) and Roam both use custom parsers; every outliner ends up here because the grammar is *not* CommonMark: blocks are line-oriented, `#tag` and `[[x]]` are first-class, `key:: value` is per block, and CommonMark's paragraph/list machinery is irrelevant inside a block.

Recommendation: hand-written tokenizer, with a documented grammar and a spec-test corpus (~200 cases). Use remark only for offline jobs (import of arbitrary markdown files, export) where correctness matters and speed does not.

### 4.2 Parser design

Block-level pass (line-oriented, once per block):

```ts
interface BlockAst {
  kind: 'text' | 'code' | 'quote' | 'heading' | 'hr';
  marker?: { type: 'todo' | 'doing' | 'done' | 'checkbox'; checked?: boolean; from: number; to: number };
  heading?: number;                                   // leading "#{1,6} "
  fence?: { lang: string; code: string };              // whole block is ```lang ... ```
  props: Array<{ key: string; value: string; from: number; to: number }>;   // trailing/leading `key:: value` lines
  body: { from: number; to: number };                  // the span passed to the inline tokenizer
}
```

Inline tokenizer (one linear scan with a small set of openers; falls back to text on any unmatched opener; **never throws**):

```ts
type Tok =
  | { t: 'text'; from; to }
  | { t: 'wikilink'; from; to; target: string; alias?: string; targetFrom; targetTo }   // [[Page]] [[Page|alias]] [[A/B/C]]
  | { t: 'tag'; from; to; name: string }                                                // #tag  #[[multi word]]
  | { t: 'blockref'; from; to; id: string }                                            // ((uuid))
  | { t: 'embed'; from; to; target: {kind:'block'|'page'; ref: string} }              // {{embed ((id))}} {{embed [[Page]]}}
  | { t: 'code'; from; to; contentFrom; contentTo }                                    // `code`
  | { t: 'strong' | 'em' | 'strike' | 'highlight'; from; to; children: Tok[] }        // ** * ~~ ==
  | { t: 'link'; from; to; text: Tok[]; href: string }                                 // [text](url), <url>, bare https://
  | { t: 'image'; from; to; alt: string; src: string }
  | { t: 'br'; from; to }                                                              // "\n" inside a block
  | { t: 'math'; from; to; tex: string };                                              // $...$ (later)

export function tokenizeInline(src: string, from = 0, to = src.length): Tok[] {
  const out: Tok[] = []; let i = from, textStart = from;
  const flush = (upTo: number) => { if (upTo > textStart) out.push({ t: 'text', from: textStart, to: upTo }); };
  while (i < to) {
    const c = src.charCodeAt(i);
    let tok: Tok | null = null;
    switch (c) {
      case 0x5B /* [ */: tok = src.charCodeAt(i+1) === 0x5B ? readWikilink(src, i, to) : readLink(src, i, to); break;
      case 0x28 /* ( */: if (src.charCodeAt(i+1) === 0x28) tok = readBlockRef(src, i, to); break;
      case 0x7B /* { */: if (src.charCodeAt(i+1) === 0x7B) tok = readMacro(src, i, to); break;
      case 0x60 /* ` */: tok = readCode(src, i, to); break;
      case 0x2A /* * */: tok = readEmphasis(src, i, to, '*'); break;   // ** strong, * em; recursive tokenizeInline on the inside
      case 0x7E /* ~ */: if (src.charCodeAt(i+1) === 0x7E) tok = readDelim(src, i, to, '~~', 'strike'); break;
      case 0x3D /* = */: if (src.charCodeAt(i+1) === 0x3D) tok = readDelim(src, i, to, '==', 'highlight'); break;
      case 0x23 /* # */: if (isWordBoundary(src, i-1)) tok = readTag(src, i, to); break;
      case 0x21 /* ! */: if (src.charCodeAt(i+1) === 0x5B) tok = readImage(src, i, to); break;
      case 0x68 /* h */: tok = readBareUrl(src, i, to); break;
      case 0x0A /* \n */: tok = { t: 'br', from: i, to: i+1 }; break;
      case 0x5C /* \ */: i += 2; continue;                              // escape: keep as text
    }
    if (tok) { flush(i); out.push(tok); i = tok.to; textStart = i; } else i++;
  }
  flush(to); return out;
}
```

Grammar decisions to write down now (they are product decisions): tags end at whitespace or `,`; `#[[multi word]]` is a tag; wikilink targets are trimmed and case-insensitive; `[[A/B/C]]` is a namespaced page; an unmatched `[[` is plain text; emphasis does not cross `\n`; `key:: value` lines are properties only when they form a contiguous run at the start (Logseq) — pick start-only for simplicity; TODO/DOING/DONE/LATER/NOW markers only at block start; a block whose first line starts with ``` is a code block in its entirety.

Rendering (`BlockView`): a Solid component per token type, emitting `data-from`/`data-to`. Wikilinks → `<a href="/page/…">`; tags → `<a class="tag">`; blockrefs → inline render of the referenced block's tokens (depth-limited to 2); checkboxes → `<input type=checkbox>` that dispatches `toggleMarker` without entering edit mode; images lazy; code fences → `shiki` 4.4.3 with `@shikijs/core` fine-grained bundle, lazy-load grammars per language, highlight in a `requestIdleCallback`, cache by (lang, code hash). Highlight.js 11.12 / lowlight 3.3 are the lighter fallback if shiki's WASM/Oniguruma cost is a problem on phones (shiki's JS regex engine avoids WASM).

Server side: the same `tokenizeInline` runs in the API to maintain the refs index (`(block) -[links_to]-> (page|block)`, tags), so backlinks/unlinked references are computed from one grammar.

---

## 5. Long pages

Needed? A journal page with 5,000 blocks × ~5 DOM nodes is 25k nodes — Chrome handles it, but first paint, layout on keyboard open/close (which resizes the viewport!), and Android low-end phones will hurt. Two tiers:

1. **`content-visibility: auto; contain-intrinsic-size: auto 2rem`** on each row. Zero code, keeps native find-in-page and anchors, browser skips layout/paint for off-screen rows. Chrome 85+, Safari 18+, Firefox 125+ (https://developer.mozilla.org/en-US/docs/Web/CSS/content-visibility). Plus Logseq-style lazy mounting for rows below the first ~200 (render a fixed-height placeholder until an IntersectionObserver says they are near).
2. **TanStack Virtual** (`@tanstack/virtual-core` 3.17.9; `@tanstack/solid-virtual` 3.13.38, `svelte-virtual` 3.13.37, `react-virtual` 3.14.11 — https://tanstack.com/virtual/latest/docs/api/virtualizer) when pages exceed a few thousand rows: flat `rows()` is exactly its input; `measureElement` + ResizeObserver handles variable heights; `overscan: 8`; `getItemKey: i => rows()[i].id`. Caveats from the docs: on iOS WebKit scroll-position writes are deferred while a finger is down / during momentum scroll — so `scrollToIndex` for keyboard navigation must be followed by the focus, not preceded; pin the editing row; absolute positioning breaks `content-visibility`, so tier 2 replaces tier 1.

Start with tier 1; the flat-row model makes tier 2 a contained change.

---

## 6. UI framework

Candidates (npm 2026-09-10): SolidJS 1.9.15 (`next` tag 2.0.0-rc.7), Svelte 5.57.0, React 19.3.0, Preact 10.29.8 + `@preact/signals` 2.11.2. Runtime sizes ≈ Solid 7 kB, Svelte 5 kB, React 45 kB (min+gz). Ecosystem by weekly downloads mid-2026 ≈ Svelte 5.3M vs Solid 2.7M (https://www.pkgpulse.com/guides/solidjs-vs-svelte-5-vs-react-reactivity-2026).

Recommendation: **SolidJS**, for this specific app:
- The block tree is the textbook case for fine-grained reactivity: `createStore` of blocks + `<For>` keyed by id means editing one block re-runs one row's memo; indent changes one CSS variable; moving a block moves one DOM node. No memoization discipline required (React needs `memo` + external-store selectors to get the same; Logseq's Rum/React + DataScript re-render storms are the cautionary tale).
- JSX, so React knowledge and LLM assistance transfer; the editor core (Surface, commands, tokenizer) is framework-free TypeScript anyway.
- Everything the app needs exists as first-party TanStack adapters: `@tanstack/solid-virtual`, `@tanstack/solid-query` 5.102.8, `@tanstack/solid-router` 1.170.32 (or `@solidjs/router` 1.0.0). Headless UI: Kobalte 0.13.14 (Radix-like: Popover, Dialog, Menu, Combobox) with solid-ui as the shadcn port; corvu for drawers/sheets. PWA: Vite 8.3.0 + `vite-plugin-pwa` 1.3.0 (Workbox) — no meta-framework needed for a client-rendered PWA with a separate API.
- Risk: Solid 2.0 is at RC 7. Start on 1.9; 2.0 keeps signals/JSX/stores and mostly changes async/transition semantics — migration is bounded. Svelte 5 is an equally sound choice if the team prefers templates (bits-ui 2.19.2 + shadcn-svelte 1.6.1 are more mature than Kobalte/solid-ui; `@tanstack/svelte-virtual`, `svelte-query` 6.1.48 exist). React 19.3 is acceptable only with a strict external-store + `memo` discipline; Preact + signals is a viable "React-shaped but fine-grained" middle ground with a smaller component ecosystem.

---

## 7. Undo/redo across text and structure

Requirement: Mod+Z undoes the last *user action*, whether it was typing in a block, splitting, indenting, moving, pasting five blocks, or deleting a subtree — and restores the caret.

Design: **one undo stack at the document level; CM6's own `history()` is not installed.** Every mutation is a transaction with an origin tag (`'local'`, `'remote'`, `'undo'`, `'api'`); the manager records only `'local'`. Two implementations depending on the sync decision:

- **CRDT-backed (recommended if the sync report chooses Yjs or Loro)** — both ship exactly this manager, local-only by design (they never undo other peers' edits):
  - Yjs 13.6.32 `Y.UndoManager(scope, { captureTimeout: 500, trackedOrigins: new Set(['local']) })`; `undo()/redo()/stopCapturing()/clear()`; `stack-item-added` / `stack-item-popped` events with `stackItem.meta` for cursor restoration (https://docs.yjs.dev/api/undo-manager). Bind CM6 with `y-codemirror.next` 0.3.6 (`yCollab(ytext, awareness, { undoManager })`), which also transforms the CM6 selection through undo.
  - Loro 1.16.1 `new UndoManager(doc, { mergeInterval: 500, maxUndoSteps: 200, excludeOriginPrefixes: ['remote', 'api'], onPush: (isUndo, range, event) => ({ value, cursors }), onPop: (isUndo, { value, cursors }) => restoreCaret(...) })`, plus `groupStart()/groupEnd()` for multi-op commands (paste, drag), `pause()/resume()` for history preview (from `loro-crdt` typings, https://loro.dev/docs/advanced/undo). Bind CM6 with `loro-codemirror` 0.3.3.
  - Block content should then be a per-block CRDT text (Y.Text / LoroText) so typing is fine-grained; structure ops are map/list ops. Undo restores both; `meta`/`cursors` carry `{blockId, head}` so undo re-attaches the surface to the right block.
- **Plain command pattern (if there is no CRDT)**:

```ts
interface Tx { ops: Op[]; inverse: Op[]; before: Caret; after: Caret; at: number; kind: 'text' | 'structure' }
class History {
  private undo: Tx[] = []; private redo: Tx[] = []; private captureUntil = 0;
  push(tx: Tx) {
    const last = this.undo.at(-1);
    if (last && tx.kind === 'text' && last.kind === 'text' && sameBlock(last, tx) && tx.at < this.captureUntil) mergeInto(last, tx);
    else this.undo.push(tx);
    this.captureUntil = tx.at + 500; this.redo = [];
  }
  stopCapturing() { this.captureUntil = 0; }          // call on every structural command and on block switch
  undoOnce() { const tx = this.undo.pop(); if (!tx) return; apply(tx.inverse, 'undo'); this.redo.push(tx); focus(tx.before); }
  redoOnce() { const tx = this.redo.pop(); if (!tx) return; apply(tx.ops, 'undo'); this.undo.push(tx); focus(tx.after); }
}
```

Text ops from CM6 come from `updateListener` as `{blockId, from, to, insert}` triples (invertible with the removed text captured from `update.startState`). Either way, the surface's keymap binds Mod+Z/Mod+Shift+Z to the document manager, and the selection-mode listener binds the same.

---

## 8. Mobile keyboard, viewport, and "native feel"

Facts to design around:
- iOS Safari opens the keyboard on `focus()` only inside a user gesture (tap, keydown). Focus the next block **synchronously** in the handler; never `setTimeout`/`rAF` before `focus()`. Logseq's hidden-anchor trick (`mobile-focus-hidden-input`) is the escape hatch when the real editor mounts asynchronously.
- iOS never resizes the layout viewport for the keyboard; only `window.visualViewport` shrinks (`height`, `offsetTop`). `interactive-widget=resizes-content` in the viewport meta is Chrome 108+ / Firefox 132+ only; WebKit bug 259770 is still NEW (last touched 2026-07-28, https://bugs.webkit.org/show_bug.cgi?id=259770; https://www.htmhell.dev/adventcalendar/2024/4/). Use it anyway — on Android it makes `100dvh` and normal flex layout keyboard-aware with zero JS.
- iOS 26.0/26.1 and the iOS 27 beta have a bug where `visualViewport.offsetTop` and `height` do not reset after the keyboard is dismissed, misaligning `position: fixed` elements (Apple forums thread 800125, FB19889436; https://iifx.dev/en/articles/460201403/debugging-ios-26-how-to-correct-fixed-positioning-post-keyboard-interaction). Treat visual-viewport values as stale when no editable is focused.
- `100vh` is wrong on iOS (URL bar); use `100dvh` (Safari 15.4+) or `height: 100%` on `html, body, #app`. In standalone PWA mode there is no URL bar, which helps.
- Scroll anchoring can fight the browser's own "scroll focused element into view" (CM6 6.38.5 worked around a Safari 26 case) — set `overflow-anchor: none` on the outliner scroll container.
- Gboard on Android sends `keydown` with `key: "Unidentified"`/`keyCode 229` and expresses Enter/Backspace via `beforeinput` — CM6 synthesizes the keys (§2.3); if you ever use the textarea fallback, handle `beforeinput.inputType` yourself.
- Tab does not exist on soft keyboards; Enter is `enterkeyhint="enter"` (do not use `done`, it suggests dismissal).

Toolbar above the keyboard (the thing that makes Workflowy/Logseq feel native):

```ts
// keyboard.ts — one CSS variable drives everything
const root = document.documentElement, vv = window.visualViewport!;
let raf = 0;
function measure() {
  raf = 0;
  const editable = document.activeElement?.closest('.cm-content, textarea, input');
  const kb = editable ? Math.max(0, window.innerHeight - vv.height - vv.offsetTop) : 0;   // iOS 26 stale-value guard
  root.style.setProperty('--kb', `${kb}px`);
  root.style.setProperty('--vv-top', `${vv.offsetTop}px`);
  root.classList.toggle('has-kb', kb > 80);
}
const schedule = () => { if (!raf) raf = requestAnimationFrame(measure); };
vv.addEventListener('resize', schedule); vv.addEventListener('scroll', schedule);
document.addEventListener('focusin', schedule); document.addEventListener('focusout', () => setTimeout(schedule, 50));
```

```css
html, body, #app { height: 100dvh; overflow: hidden; }
.outliner-scroll { height: 100%; overflow-y: auto; overscroll-behavior: contain; overflow-anchor: none;
                   scroll-padding-bottom: calc(var(--kb, 0px) + 56px); padding-bottom: calc(var(--kb, 0px) + 56px); }
.kb-toolbar { position: fixed; left: 0; right: 0; top: 0; height: 44px;
              transform: translateY(calc(var(--vv-top, 0px) + 100dvh - var(--kb, 0px) - 100%)); /* iOS: pinned to visual viewport bottom */
              display: none; }
html.has-kb .kb-toolbar { display: flex; }
@supports (height: 100dvh) { /* Android with interactive-widget=resizes-content: --kb is ~0, dvh already shrank, toolbar sits at bottom naturally */ }
```

```tsx
// Toolbar buttons must not steal focus from the editor
<button onPointerDown={e => e.preventDefault()} onClick={() => commands.indent(ctx())} aria-label="Indent">⇥</button>
```

Buttons: outdent, indent, move up, move down, `[[`, `#`, `((`, `/`, checkbox, undo, redo, hide keyboard. On Enter/Backspace-merge the surface moves but the keyboard stays because focus moves synchronously. After the keyboard opens, scroll the caret into view above the toolbar (`EditorView.scrollIntoView(head, { yMargin: 64 })` — Logseq does the same in `:mobile/keyboard-will-show`).

Other native-feel rules: tap targets ≥ 44 px (bullet + row padding), no hover-only affordances, `touch-action: manipulation` to kill the 300 ms delay/double-tap zoom, `-webkit-tap-highlight-color: transparent`, long-press for selection mode, `env(safe-area-inset-bottom)` on the toolbar when the keyboard is closed, no layout shift between view/edit (§3.2), and never re-render the whole list when the keyboard opens (fine-grained rendering — the resize only changes `--kb`).

Logseq's 2026 native toolbar plugin is the ceiling: a PWA cannot draw a native accessory view. If a Capacitor 8.5 shell is added later, `@capacitor/keyboard` 8.0.5 `keyboardWillShow` gives exact heights and a native toolbar plugin is ~300 lines of Swift/Kotlin (copy Logseq's).

---

## 9. Risks and mitigations

1. **Device-specific CM6 composition bugs** (Samsung keyboard, Gboard swipe, Chinese IMEs). Mitigation: Obsidian's install base surfaces these first and Marijn fixes them within weeks (changelog cadence above); keep the `Surface` interface and a textarea fallback; build a device test matrix early (iPhone Safari, iPad, Pixel Chrome, Samsung Internet) with a scripted "type/split/merge/indent/CJK" checklist.
2. **iOS viewport regressions** (iOS 26/27 `offsetTop` bug). Mitigation: the stale-value guard above; avoid `position: fixed` for anything except the toolbar; test each iOS beta.
3. **Grammar drift** between our tokenizer, remark import/export, and what users paste from Obsidian/Logseq. Mitigation: written grammar + spec corpus; importer runs remark and normalizes into our grammar; unknown syntax stays as text (never dropped).
4. **Undo semantics** must be chosen with the sync model; retrofitting CRDT undo onto a command-pattern history is painful. Decide in the sync report before the editor's second week.
5. **Virtualization + editing** interactions (focus on unmounted rows, iOS deferred scroll writes). Mitigation: tier 1 first; flat rows keep tier 2 contained.
6. **Bundle**: CM6 (+75–157 kB br) is the largest chunk; code-split the markdown language pack, shiki grammars, and the autocomplete index; the PWA caches it once.
7. **Solid 2.0 migration** (RC now). Bounded; or pick Svelte 5.
8. **Scope**: the editor is ~half the product. A realistic solo budget for §3–§8 at "better than Logseq on mobile" quality is 6–8 focused weeks, with the mobile toolbar/keyboard work being the least predictable part.

---

## 10. Sources

Editors and changelogs
- CodeMirror changelog: https://codemirror.net/docs/changelog/ ; system guide: https://codemirror.net/docs/guide/ ; front page ("Use the platform's native selection and editing features on phones"): https://codemirror.net/
- Lezer markdown extension API: https://github.com/lezer-parser/markdown
- ProseMirror changelog: https://prosemirror.net/docs/changelog/ ; archived GitHub org → https://code.haverbeke.berlin/prosemirror/prosemirror ; Android thread: https://discuss.prosemirror.net/t/contenteditable-on-android-is-the-absolute-worst/3810 ; issues #784, #565, #1189, #1069 on https://github.com/ProseMirror/prosemirror/issues
- Lexical IME issues: https://github.com/facebook/lexical/issues/8098 , https://github.com/facebook/lexical/issues/6354 , https://github.com/facebook/lexical/issues/1716 ; changelog https://github.com/facebook/lexical/blob/main/CHANGELOG.md
- Slate Android input manager: https://github.com/ianstormtaylor/slate/tree/main/packages/slate-react/src/hooks/android-input-manager ; Hangul issue https://github.com/ianstormtaylor/slate/issues/5989
- BlockNote: https://www.blocknotejs.org/ , https://github.com/TypeCellOS/BlockNote ; BlockSuite: https://github.com/toeverything/blocksuite , https://www.npmjs.com/package/@blocksuite/affine
- Atomic Editor: https://github.com/kenforthewin/atomic-editor , https://news.ycombinator.com/item?id=48345201
- Obsidian on CM6 everywhere: https://news.ycombinator.com/item?id=31669303 ; CM6 6.0 thread https://news.ycombinator.com/item?id=31666186
- SilverBullet PWA: https://silverbullet.md/PWA ; mobile keyboard issue https://github.com/silverbulletmd/silverbullet/issues/704 ; LWN review https://lwn.net/Articles/1030941/

Logseq
- editor handler: https://github.com/logseq/logseq/blob/master/src/main/frontend/handler/editor.cljs ; editor component: https://github.com/logseq/logseq/blob/master/src/main/frontend/components/editor.cljs ; cursor utils: https://github.com/logseq/logseq/blob/master/src/main/frontend/util/cursor.cljs ; `ls-textarea`: https://github.com/logseq/logseq/blob/master/src/main/frontend/ui.cljs ; block rendering: https://github.com/logseq/logseq/blob/master/src/main/frontend/components/block.cljs
- native toolbar: https://github.com/logseq/logseq/blob/master/ios/App/App/NativeEditorToolbarPlugin.swift , https://github.com/logseq/logseq/blob/master/android/app/src/main/java/com/logseq/app/NativeEditorToolbarPlugin.kt , https://github.com/logseq/logseq/blob/master/android/app/src/main/java/com/logseq/app/WebViewKeyboardRecovery.kt ; web side: https://github.com/logseq/logseq/blob/master/src/main/frontend/mobile/util.cljs , https://github.com/logseq/logseq/blob/master/src/main/frontend/handler/events.cljs
- issues: https://github.com/logseq/logseq/issues/6030 , https://github.com/logseq/logseq/issues/6126 , https://github.com/logseq/logseq/issues/1750 , https://github.com/logseq/logseq/issues/6805 , https://github.com/logseq/logseq/issues/5478 ; forum https://discuss.logseq.com/t/how-to-make-block-display-same-in-editing-mode-and-view-mode/18285 ; DB version https://discuss.logseq.com/t/whats-new-with-logseq-db-may-16th-2026/35020 , https://news.ycombinator.com/item?id=48896229 , https://github.com/logseq/docs/blob/master/db-version.md

Roam / Workflowy / Tana
- roam-toolkit selectors: https://github.com/roam-unofficial/roam-toolkit/blob/master/src/ts/core/roam/selectors.ts ; Workflowy DOM via https://github.com/rawbytz/focus-fix ; Workflowy help: https://workflowy.com/help/add-edit-format/ , https://blog.workflowy.com/updated-design-for-creating-new-pages-via/ , https://blog.workflowy.com/update-mar-26/ ; Tana 2025 updates: https://tana.inc/articles/whats-new-in-tana-2025-product-updates , https://tana.inc/articles/what-new-in-tana-2024-2025

Markdown parsing
- micromark: https://www.npmjs.com/package/micromark ; performance discussion https://github.com/orgs/micromark/discussions/29 ; benchmarks https://www.measurethat.net/Benchmarks/Show/16035/0/micromark-vs-markdown-it-parser , https://www.measurethat.net/Benchmarks/Show/34403/1/markdown-parser-performance-comparison-as-of-may-2025 ; "Don't use marked" https://macwright.com/2024/01/28/dont-use-marked
- wikilink extensions: https://github.com/landakram/micromark-extension-wiki-link , https://www.npmjs.com/package/remark-wiki-link , https://www.npmjs.com/package/@moritzrs/micromark-extension-ofm-wikilink , https://www.npmjs.com/package/@braindb/remark-wiki-link
- textarea caret positioning: https://www.npmjs.com/package/textarea-caret , https://dev.to/phuocng/calculate-the-coordinates-of-the-current-cursor-in-a-text-area-cle

Virtualization, frameworks, undo
- TanStack Virtual: https://tanstack.com/virtual/latest/docs/api/virtualizer
- Framework comparisons: https://www.pkgpulse.com/guides/solidjs-vs-svelte-5-vs-react-reactivity-2026 , https://www.pkgpulse.com/guides/solidjs-vs-svelte-2026 , https://solodevstack.com/blog/solidjs-vs-svelte-solo-developers
- Yjs UndoManager: https://docs.yjs.dev/api/undo-manager ; Loro undo: https://loro.dev/docs/advanced/undo ; CRDT comparison https://www.pkgpulse.com/guides/yjs-vs-automerge-vs-loro-crdt-libraries-2026 ; bindings https://www.npmjs.com/package/y-codemirror.next , https://www.npmjs.com/package/loro-codemirror

Mobile viewport / keyboard
- VisualViewport: https://developer.mozilla.org/en-US/docs/Web/API/VisualViewport ; Safari 13 + keyboards: https://tkte.ch/articles/2019/09/23/safari-13-mobile-keyboards-and-the-visualviewport-api.html ; fixed elements + iOS keyboard: https://saricden.com/how-to-make-fixed-elements-respect-the-virtual-keyboard-on-ios , https://rdavis.io/articles/dealing-with-the-visual-viewport
- `interactive-widget`: https://www.htmhell.dev/adventcalendar/2024/4/ , https://bugs.webkit.org/show_bug.cgi?id=259770 , https://github.com/w3c/csswg-drafts/issues/10464 ; VirtualKeyboard API https://www.bram.us/2021/09/13/prevent-items-from-being-hidden-underneath-the-virtual-keyboard-by-means-of-the-virtualkeyboard-api/
- iOS 26 bug: https://developer.apple.com/forums/thread/800125 , https://iifx.dev/en/articles/460201403/debugging-ios-26-how-to-correct-fixed-positioning-post-keyboard-interaction , https://medium.com/@krutilin.sergey.ks/fixing-the-safari-mobile-resizing-bug-a-developers-guide-6568f933cde0

Package versions verified on npm 2026-09-10: @codemirror/view 6.43.11, @codemirror/state 6.7.4, @codemirror/lang-markdown 6.5.2, @codemirror/autocomplete 6.20.3, @codemirror/commands 6.11.0, @lezer/markdown 1.7.2, prosemirror-view 1.42.3, prosemirror-model 1.25.11, prosemirror-markdown 1.13.7, @tiptap/core 3.31.3, @blocknote/core 0.54.2, lexical 0.50.0, slate 0.126.2, @blocksuite/affine 0.22.4, @milkdown/core 7.22.1, @editorjs/editorjs 2.31.6, micromark 4.0.2, mdast-util-from-markdown 2.0.3, markdown-it 15.0.1, micromark-extension-wiki-link 0.0.4, remark-wiki-link 2.0.1, mdast-util-wiki-link 0.1.2, @moritzrs/micromark-extension-ofm-wikilink 0.0.1, micromark-extension-cjk-friendly 2.0.1, @tanstack/virtual-core 3.17.9, @tanstack/solid-virtual 3.13.38, @tanstack/svelte-virtual 3.13.37, @tanstack/react-virtual 3.14.11, solid-js 1.9.15 (next 2.0.0-rc.7), svelte 5.57.0, react 19.3.0, preact 10.29.8, @preact/signals 2.11.2, @kobalte/core 0.13.14, bits-ui 2.19.2, shadcn-svelte 1.6.1, @solidjs/router 1.0.0, @tanstack/solid-query 5.102.8, @tanstack/solid-router 1.170.32, vite 8.3.0, vite-plugin-pwa 1.3.0, yjs 13.6.32, loro-crdt 1.16.1, y-codemirror.next 0.3.6, loro-codemirror 0.3.3, shiki 4.4.3, highlight.js 11.12.0, lowlight 3.3.0, @atlaskit/pragmatic-drag-and-drop 3.1.0, @dnd-kit/core 6.3.1, @capacitor/core 8.5.1, @capacitor/keyboard 8.0.5, textarea-caret 3.1.0.
