# Bug inbox — delete-launcher (M11)

Entries in `docs/BUGS.md`'s format, for the coordinator to fold in. New numbers B-490..B-499.

---

### B-491 · `window.confirm()` is always "Cancel" and `window.alert()` shows nothing in the desktop app
**Status:** open · **Severity:** high · **Found:** 2026-09-13, delete-launcher (choosing how to
confirm a page delete) · **Test:** none yet; probe `tools/probes/wkwebview-confirm.swift`

The desktop app is a WKWebView through wry 0.55.1, whose `WKUIDelegate`
(`wry-0.55.1/src/wkwebview/class/wry_web_view_ui_delegate.rs`) implements the file-upload panel,
media-capture permission and new windows — and none of the JavaScript panel methods
(`webView:runJavaScriptConfirmPanelWithMessage:…`, `…AlertPanel…`, `…TextInputPanel…`). WebKit then
answers without showing anything. The probe builds exactly that (a UI delegate with no panel
methods) and prints `confirm returned false after 0 ms` / `alert returned undefined after 1 ms`.

What that breaks in the app today, found by grep, none of it verified in a built app:

- History view: "Undo" and "Restore this version" both open with `window.confirm`
  (`views/HistoryView.tsx`) — on the desktop app they silently do nothing.
- Every failure reported through `window.alert` is invisible there: "Turn into page / Move to page /
  Merge page failed" (`app/refactor-host.tsx`), "Rename failed" (`views/PageView.tsx`), "Could not
  clear the local copy" (`views/GraphMismatchView.tsx`). The action fails with no word.

Chromium (the e2e suite) shows real dialogs, which is why no test noticed. Fix direction: an
in-page dialog. `apps/web/src/app/confirm-dialog.tsx` (being added for Delete page on this branch) is a
drop-in for the confirms; the alerts want the same or an inline error line. Not done here — those
call sites belong to other workstreams.
