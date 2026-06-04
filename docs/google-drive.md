# Google Drive

Provider-specific notes for syncing Claude Code memory with Google Drive. For the
universal flow — finding your memory path, running `setup`, linking a second machine —
read **[the shared setup guide](setup.md)** first; this page only covers what's
particular to Drive.

**Platform note.** macOS and Windows are first-class. Google ships **no official Drive
desktop client for Linux** — you bridge the gap with a third-party tool, which changes
the offline guarantee (see [Linux](#linux) below). If your Linux box is the priority,
Dropbox is the only one of the four providers with an official Linux client.

---

## Where Google Drive lives

This is the `$TARGET` you'd use in the manual appendix of the shared guide; `setup`
detects it automatically.

### macOS

Drive for desktop mounts under `~/Library/CloudStorage/GoogleDrive-<account>/My Drive/`.
The `My Drive` part is **localized** to your system language — `Mijn Drive` on a Dutch
Mac, `Meine Ablage` on a German one, and so on. Don't hardcode the English name; find it:

```bash
ls -d ~/Library/CloudStorage/GoogleDrive-*/*/ 2>/dev/null
DRIVE_ROOT="$(ls -d ~/Library/CloudStorage/GoogleDrive-*/My\ Drive 2>/dev/null | head -1)"
TARGET="$DRIVE_ROOT/claude-memory/-Users-$(whoami)"
```

### Windows

Drive appears as a **virtual drive**, by default `G:` (changeable in Drive settings),
with My Drive at `G:\My Drive\` — not under your user profile.

```powershell
$TARGET = "G:\My Drive\claude-memory\-Users-$env:USERNAME"
```

### Linux

There is **no official Google Drive client for Linux**. Realistic options:

- **rclone** — `rclone mount` exposes Drive as a filesystem, but a plain VFS mount
  streams on demand, so a background reader can hit an uncached file. You must use
  `--vfs-cache-mode full` *and* ensure the files have been cached, or the offline
  guarantee doesn't hold. A scheduled `rclone bisync` to a real local directory is the
  dependable shape.
- **Insync** (paid) — a GUI client that keeps a real local folder behaving much like
  the macOS/Windows clients.

Point `$TARGET` at whatever local directory your tool keeps in sync, e.g.
`"$HOME/GoogleDrive/claude-memory/-home-$(whoami)"`.

### Multiple accounts

If more than one Google account is signed in, pick one:

```sh
npx claude-memory-sync setup --provider google --account you@gmail.com
```

---

## Make the folder available offline

Drive for desktop can **stream** files instead of storing them, leaving cloud
placeholders on disk. When that happens Claude follows the link, finds an empty or
placeholder folder, and reads no memory.

### macOS / Windows

**Option A — Mirror My Drive (recommended, set once):** Drive icon → **Settings** /
**Preferences** → **Folders from Drive** (macOS) or **Google Drive** (Windows) → under
**My Drive syncing options** choose **Mirror files** → **Save**. Mirrored files are
always stored both locally and in the cloud, even when the Drive app isn't running —
which matters, because streamed files (even pinned ones) are only readable while Drive
for desktop is running.

**Option B — pin just the folder:** right-click your `claude-memory` folder →
**Offline access** → **Available offline**.

OneDrive's 400-character path cap does **not** apply to Drive, so path length is rarely
an issue here.

### Linux

No GUI toggle, because there's no official client. The guarantee comes from your sync
tool: an `rclone mount` is only durably local with `--vfs-cache-mode full` *and* the
file cached at least once; an `rclone bisync` / Insync real local folder is always
readable. For a hard offline guarantee, keep a real local sync directory, not a bare
VFS mount.

---

## Provider-specific warnings

- **Streaming eviction is the main risk.** If you ever switch from Mirror back to
  Stream, or a new machine defaults to streaming, the memory folder can become
  cloud-only and Claude reads nothing. Re-apply the offline step.
  `npx claude-memory-sync doctor` checks for this.
- **Linux has no official client.** The offline guarantee depends entirely on your
  rclone/Insync configuration. A bare rclone mount is not a durable local copy.
- **Localized folder names (macOS).** Always confirm the real `My Drive` / `Mijn
  Drive` path rather than hardcoding the English name.
- **Links are never uploaded.** Drive syncs the real files in `$TARGET`; the link
  lives only in `~/.claude` and is never synced. Don't place the link inside the Drive
  folder.
- **Don't run two live sessions at once.** Simultaneous writes produce Drive conflict
  copies (e.g. `MEMORY (1).md`). See [Concurrent writes](concurrent-writes.md).
