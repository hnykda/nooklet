cask "nooklet" do
  arch arm: "arm64", intel: "x64"

  # `version` and both `sha256` values are rewritten on every release by
  # .github/workflows/homebrew-tap.yml in hnykda/nooklet (tools/ci/homebrew-cask.mjs), from the
  # release's own SHA256SUMS. Edit the rest of this file there, in packaging/homebrew/, not in the tap.
  version "0.1.0"
  # Placeholders until the first stamp (they must differ, or `brew style` objects).
  sha256 arm:   "1111111111111111111111111111111111111111111111111111111111111111",
         intel: "2222222222222222222222222222222222222222222222222222222222222222"

  url "https://github.com/hnykda/nooklet/releases/download/v#{version}/nooklet-#{version}-macos-#{arch}.dmg"
  name "nooklet"
  desc "Local-first outliner with first-class access for AI agents"
  homepage "https://github.com/hnykda/nooklet"

  livecheck do
    url :url
    strategy :github_latest
  end

  depends_on :macos

  app "nooklet.app"
  # The app ships its own server (Node + server.mjs + sqlite-vec, apps/desktop/build-sidecar.mjs);
  # this puts that same server on PATH as `nooklet`, so `nooklet import`, `nooklet mcp --stdio` and
  # `nooklet token create` work without a source checkout. The variables are the ones the app sets
  # when it starts the server itself (apps/desktop/src-tauri/src/main.rs#spawn_server); without
  # NOOKLET_WEB_DIR, `nooklet serve` from the bundle serves the API but not the web client.
  command_wrapper "nooklet",
                  executable: "#{appdir}/nooklet.app/Contents/Resources/sidecar/node",
                  args:       ["#{appdir}/nooklet.app/Contents/Resources/sidecar/server.mjs"],
                  env:        {
                    NOOKLET_SQLITE_VEC_PATH: "#{appdir}/nooklet.app/Contents/Resources/sidecar/vec0.dylib",
                    ESBUILD_BINARY_PATH:     "#{appdir}/nooklet.app/Contents/Resources/sidecar/esbuild",
                    NOOKLET_WEB_DIR:         "#{appdir}/nooklet.app/Contents/Resources/sidecar/web",
                    NODE_ENV:                "production",
                  }

  uninstall quit: "com.nooklet.desktop"

  # Deliberately NOT here: ~/.nooklet. It holds every graph (the SQLite databases, the op log, the
  # markdown mirror and attachments), shared with the `nooklet` CLI and any `nooklet serve`. A
  # `brew uninstall --zap` must never delete notes. Remove it by hand if you mean to.
  #
  # Also not removed: ~/Library/Application Support/com.nooklet.desktop/graph. Development builds
  # before 0.1.0 kept a graph there; `rmdir` below only removes the directory once it is empty.
  #
  # Everything is moved to the Trash rather than deleted. The WebKit directory is the window's
  # browser storage: for a graph on another server it can hold edits made offline that have not
  # synced yet.
  zap trash: [
        "~/Library/Application Support/com.nooklet.desktop/desktop.json",
        "~/Library/Application Support/com.nooklet.desktop/show_picker_once",
        "~/Library/Caches/com.nooklet.desktop",
        "~/Library/HTTPStorages/com.nooklet.desktop",
        "~/Library/Preferences/com.nooklet.desktop.plist",
        "~/Library/Saved Application State/com.nooklet.desktop.savedState",
        "~/Library/WebKit/com.nooklet.desktop",
      ],
      rmdir: "~/Library/Application Support/com.nooklet.desktop"

  caveats <<~EOS
    nooklet is not signed or notarized by Apple yet, so macOS refuses to open it
    ("damaged" or "cannot be verified"). After installing, and again after each
    upgrade, clear the download quarantine:

      xattr -dr com.apple.quarantine #{appdir}/nooklet.app

    (If macOS offers Open Anyway in System Settings > Privacy & Security
    after a refused launch, that works too; for a "damaged" message it does not.)

    Your notes are in ~/.nooklet. `brew uninstall --zap nooklet` does not touch them.

    So that `brew upgrade` can load this cask, trust the tap once:

      brew trust hnykda/nooklet
  EOS
end
