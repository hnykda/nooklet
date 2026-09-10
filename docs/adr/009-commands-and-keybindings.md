# ADR 009: Every operation is a command; keybindings are user data

Date: 2026-09-10. Status: accepted.

## Decision

- A command is `{ id, title, description, category, when, defaultKeys, run }`. Core registers
  every user-facing operation; plugins register theirs, declaratively in the manifest so they
  appear before code loads.
- Keybindings are a synced setting (`keybindings.json`: `{ key, command, when }`) with a UI that
  lists commands, shows conflicts, records chords, and supports platform variants.
- The command palette searches commands and pages; the slash menu shows editor-context commands
  and inserts; the mobile keyboard toolbar and long-press menus show the same commands.

## Why

Tana's "every command is named and rebindable" and Logseq's palette are the parts users keep;
a single registry means the palette, slash menu, toolbar, keymap UI, and plugin contributions
never drift apart.
