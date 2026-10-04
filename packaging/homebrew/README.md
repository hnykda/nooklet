# homebrew-nooklet

The Homebrew tap for [nooklet](https://github.com/hnykda/nooklet), a local-first outliner with
first-class access for AI agents.

```sh
brew install --cask hnykda/nooklet/nooklet
brew trust hnykda/nooklet      # once, so `brew upgrade` can load the cask later
```

This installs `nooklet.app` (Apple Silicon or Intel, whichever you have) from the
[GitHub Release](https://github.com/hnykda/nooklet/releases), plus a `nooklet` command: the app's
own bundled server, for `nooklet import`, `nooklet mcp --stdio`, `nooklet token create` and the
rest (`nooklet` with no arguments lists them).

**Do not edit this repository by hand.** It is generated from `packaging/homebrew/` in
hnykda/nooklet; every release copies that directory here and stamps the version and checksums
(`.github/workflows/homebrew-tap.yml` there). Change the cask there.

## The app is not signed

nooklet has no Apple Developer ID yet, so the app is neither signed nor notarized. macOS refuses
to open it the first time ("is damaged and can't be opened" or "cannot be verified"). After you
install, **and after each `brew upgrade nooklet`**, clear the download quarantine:

```sh
xattr -dr com.apple.quarantine /Applications/nooklet.app
```

If macOS instead says it "cannot be verified", System Settings → Privacy & Security → **Open
Anyway** after the refused launch works too; for "damaged" only the command above does.

The cask does not do this for you. Homebrew removed its own `--no-quarantine` option because it
"does not wish to easily provide circumvention to macOS security features"
([Homebrew 5.0.0](https://brew.sh/2025/11/12/homebrew-5.0.0/)); a cask that quietly strips the
attribute would be exactly that, without asking you. Clearing it is your decision.

## Why it is not in homebrew/cask

Homebrew deprecated unsigned casks in 5.0.0 (November 2025) and disables every homebrew/cask cask
that fails Gatekeeper from September 2026 ([5.0.0](https://brew.sh/2025/11/12/homebrew-5.0.0/),
[6.0.0](https://brew.sh/2026/06/11/homebrew-6.0.0/)). Third-party taps are not checked: "By
default, we don't even check signing status on third-party taps"
([Homebrew discussion #6482](https://github.com/orgs/Homebrew/discussions/6482)). So a tap works;
the official cask has to wait for a signed, notarized build.

## Uninstalling

```sh
brew uninstall --cask nooklet          # the app and the `nooklet` command
brew uninstall --cask --zap nooklet    # also its settings, caches and window storage (to the Trash)
```

**Your notes are never removed.** They live in `~/.nooklet` (shared with the `nooklet` command and
any `nooklet serve`), which neither command touches. Delete it yourself if you mean to.

## Linux, Windows, a server

- Linux and Windows builds, and the server's Docker image, are on the
  [Releases page](https://github.com/hnykda/nooklet/releases).
- The server on its own (no app) runs from Docker or from source:
  [self-hosting](https://github.com/hnykda/nooklet/blob/main/docs/guide/self-hosting.md).
