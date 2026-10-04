---
title: Sync between devices
description: How edits travel between your devices through your own server, and what happens when two of them disagree.
order: 2
---

> Placeholder page. The real guide lives in `docs/guide/` at the repository root.

Every device keeps a full copy of your graph. You can write on a plane, on a phone in a tunnel,
or on a laptop with the server switched off. When the device reconnects, it sends what it wrote
and fetches what it missed.

## What travels

Each edit becomes an *op*: a small record that names one block, one field, and the new value. The
op carries a hybrid logical clock stamp, so any two ops can be put in order.

```json
{ "kind": "block.text", "id": "b_7Qx", "text": "Call the plumber on Monday", "hlc": "1759573200000:0003:laptop" }
```

```animation-spec
id: sync-op
caption: One edit leaves the laptop, the server gives it a sequence number, and the phone pulls it.
```

## Two devices, both offline

Fields merge independently. If the laptop edits a block's text and the phone moves the same block,
both changes survive.

```animation-spec
id: sync-converge
caption: Two devices edit offline, reconnect, and end up with the same outline.
```

## The same block, edited twice

When both devices change the text of one block, nooklet tries a word-level three-way merge first.
If the edits touch different words, you get both. If they overlap, the later edit wins and the
other one stays on the block as a `conflict_copy` property, so you can read it and decide.

```animation-spec
id: sync-merge
caption: Two edits to one sentence merge word by word.
```
