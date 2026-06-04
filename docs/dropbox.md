# Dropbox

Provider-specific notes for syncing Claude Code memory with Dropbox. For the universal
flow — finding your memory path, running `setup`, linking a second machine — read
**[the shared setup guide](setup.md)** first; this page only covers what's particular
to Dropbox.

**Platform note.** Dropbox is the one provider here that ships an **official desktop
client for all three operating systems**, Linux included. That makes it the cleanest
choice if any of your machines run Linux. macOS, Windows and Linux are all first-class.

---

## Where Dropbox lives

This is the `$TARGET` you'd use in the manual appendix of the shared guide; `setup`
detects it automatically.

### macOS

The classic location is `~/Dropbox/`. Newer clients (using Apple's File Provider
system) mount it under `~/Library/CloudStorage/Dropbox/` instead. Find whichever you
have:

```bash
DROPBOX_ROOT="$(ls -d ~/Dropbox ~/Library/CloudStorage/Dropbox 2>/dev/null | head -1)"
TARGET="$DROPBOX_ROOT/claude-memory/-Users-$(whoami)"
```

### Windows

Dropbox lives under your user profile at `%UserProfile%\Dropbox\`. With both a personal
and a Business account you'll see `Dropbox (Personal)` and `Dropbox (<Team>)` instead.

```powershell
$TARGET = "$env:USERPROFILE\Dropbox\claude-memory\-Users-$env:USERNAME"
```

### Linux

Dropbox ships an **official Linux client** (desktop and headless) that keeps a real
local folder just like the other platforms — no third-party tooling. Default location
`~/Dropbox/`:

```bash
TARGET="$HOME/Dropbox/claude-memory/-home-$(whoami)"
```

One caveat: on some setups the official Linux client requires the Dropbox folder to
live on an **unencrypted ext4** filesystem and refuses to sync otherwise. If syncing
won't start, check the filesystem of `~/Dropbox` first.

---

## Make the folder available offline

Dropbox can keep files as **online-only** placeholders (Smart Sync) to save disk
space. When a folder is online-only, Claude follows the link, finds placeholders, and
reads no memory.

### macOS / Windows / Linux

Right-click your `claude-memory` folder in your file manager and choose **Make
available offline**. A green check means it's downloaded; a grey cloud icon means
online-only — the state to avoid.

To make *everything* offline by default (so future files never go online-only):
Dropbox tray/menu-bar icon → your avatar → **Preferences** → **Sync** → **New files
default** → **Available offline**.

On Linux, because it's a real local client (not an on-demand mount), a folder you
created or moved into `~/Dropbox` locally is already on disk.

---

## Provider-specific warnings

- **Online-only eviction is the main risk.** If the `claude-memory` folder ever flips
  back to online-only, Claude reads only placeholders. Re-apply the offline step.
  `npx claude-memory-sync doctor` checks for this.
- **Symlinks/junctions and Dropbox.** Dropbox syncs the real files in `$TARGET`; the
  link in `~/.claude` stays local and is never synced — keep it there, not inside the
  Dropbox folder. Dropbox officially recommends exactly our shape (real files inside
  Dropbox, link pointing in from outside) and does **not** sync the targets of symlinks
  placed inside Dropbox. On **Windows** Dropbox doesn't sync junctions or symlinks at
  all, so never put one inside the Dropbox folder there.
- **Don't run two live sessions at once.** Simultaneous writes produce Dropbox
  conflicted copies (e.g. `MEMORY (Mac's conflicted copy 2026-05-30).md`). See
  [Concurrent writes](concurrent-writes.md).
