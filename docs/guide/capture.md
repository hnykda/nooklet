---
title: Capturing from anywhere on the phone
description: Add a note to today's journal from a link, the app icon, Shortcuts, Siri, the Action Button or Android's share sheet.
order: 2.5
---

# Capturing from anywhere on the phone

Every way in described here ends in the same place: a new block at the end of today's journal in
the graph you have open. It is written on the phone first, so it works offline, and syncs like any
other edit. What gets written:

- text you share or type: the text;
- a link with a page title: `[title](url)`;
- a bare link: the URL.

Pictures are not handled yet.

## The capture screen

Most entry points open the **capture screen**: one text field, **Save to journal** and **Cancel**
above it. Whatever arrived is already in the field. Nothing is saved until you tap Save, so you can
edit first or cancel. This matters: any app or web page can open a `nooklet://` link, and a link
can only fill in the screen, never write on its own.

If the phone has no graph yet (the app was just installed), the screen says so and keeps the text.
Tap **Set up a graph**; the next time you open the capture screen, the text is waiting there.

## Links: `nooklet://capture`

```
nooklet://capture?text=walk%20the%20dog
nooklet://capture?url=https%3A%2F%2Fexample.com%2Fa&title=An%20article
```

`text`, `url` and `title` are all optional. Use these from the Shortcuts app ("Open URLs"), from
another app's automation, or from a bookmark. In a browser, the same thing works as
`<your graph address>/capture?text=…`.

`nooklet://today` opens today's journal and `nooklet://search` opens search.

## Long-press the app icon (iPhone and Android)

Press and hold the nooklet icon on the Home Screen:

- **New note** opens the capture screen, empty.
- **Today** opens today's journal.
- **Search** opens search.

## "Add to nooklet" in Shortcuts, Siri and Spotlight (iPhone)

nooklet gives the Shortcuts app two actions, with no setup:

- **Add to nooklet** takes some text and adds it to today's journal **without opening the app**.
  The block appears the next time you open nooklet (or bring it back to the front). Captures made
  while the app is closed keep their own time and land on the journal day they were made, in the
  order you made them.
- **Open nooklet to add** opens the capture screen with the text filled in, to edit and save.

Ways to use them:

- **Siri:** "Add to nooklet" (or "Add a note to nooklet", "Capture in nooklet"). Siri asks what to
  add.
- **Spotlight:** type "Add to nooklet".
- **Shortcuts:** add the action to your own shortcut, for example "Get Clipboard" → "Add to
  nooklet".

### The Action Button (iPhone 15 Pro and later)

1. Open **Settings → Action Button**.
2. Swipe to **Shortcut**.
3. Tap **Choose a Shortcut** and pick **Add to nooklet** (listed under nooklet's App Shortcuts).

Now pressing and holding the Action Button asks "What do you want to add?"; dictate or type, and
it is queued for today's journal without opening nooklet. If you would rather see the capture
screen every time, pick **Open nooklet to add** instead.

## Sharing from another app (Android)

In any app's share sheet, pick **nooklet**. Text and links open the capture screen pre-filled; a
shared link with a page title becomes `[title](url)`. Tap Save. (Android is experimental and has
not been tried on a device yet.)

On iPhone, sharing straight into nooklet from the share sheet needs a Share Extension, which is
planned but not built (proposal 006, Phase 2). Until then, use a Shortcut that receives the share
sheet's input and runs **Add to nooklet**.

## What is verified

On the iOS Simulator: the capture screen from a link, with and without a graph; the queue that
"Add to nooklet" writes, drained on launch and on return to the foreground; the quick actions'
handlers; "Open nooklet to add". Not yet tried on a real iPhone: the long-press menu itself, Siri,
the Action Button, and running the actions from the Shortcuts app. Android has not run at all.
Details: `docs/progress/phone-capture.md`.
