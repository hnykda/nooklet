# ADR 006: Editor: rendered blocks plus one re-parented CodeMirror 6 surface

Date: 2026-09-10. Status: accepted.

## Decision

- All blocks render as HTML from our own inline markdown tokenizer. Exactly one editing surface
  exists at a time: a single CodeMirror 6 `EditorView` re-parented into the block being edited.
  The block's markdown string is the only source of truth; no rich-text document model.
- The tokenizer is hand-written, offset-annotated, and shared by the renderer, the editor's
  live-preview decorations, and the server's reference indexer. `remark` is used only for
  import/export of foreign markdown.
- UI framework: SolidJS 1.9 (fine-grained reactivity, JSX, TanStack adapters). Svelte 5 is the
  documented alternative if the user prefers it.
- Undo/redo is a document-level history of inverse ops with 500 ms coalescing of text edits.
- A `Surface` interface hides the editor engine; a small textarea implementation is the
  fallback for devices where CodeMirror composition misbehaves.
- Mobile: the surface moves between blocks inside trusted events so focus transfers while the
  keyboard stays up; a toolbar above the keyboard exposes indent/outdent/move/task/date; swipe
  indents, long-press on the bullet drags.

## Why

- Logseq's per-block textarea proves the single-surface architecture is robust, but its raw
  markdown while editing, mirror-div caret hacks, and hand-rolled Android handling are the
  weak points. CodeMirror 6 gives syntax-aware editing, live-preview decorations, and IME
  handling that Obsidian has shipped on iOS and Android since 2021, at a measured 0.2 ms per
  mount and about 150 kB compressed.
- ProseMirror/Tiptap/BlockNote/Lexical impose a rich-text model where markdown is a lossy
  export, which is the wrong shape for an app whose API and MCP surface is markdown strings, and
  they still ship monthly Android/IME workarounds in 2026.
- On 20k realistic blocks the hand-written tokenizer measured 0.6 µs per block versus 4.4 µs
  for markdown-it and 30 µs for micromark; the micromark wikilink extensions are stale.

## Consequences

- No WYSIWYG for bold/italic while editing a block; the rendered view shows formatting, the
  editing view shows markdown with syntax highlighting and live-preview decorations for links.
- The grammar we accept must be written down; unknown syntax stays plain text.
