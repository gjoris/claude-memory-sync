# OneDrive

Provider-specific notes for syncing Claude Code memory with OneDrive. For the
universal flow — finding your memory path, running `setup`, linking a second machine —
read **[the shared setup guide](setup.md)** first; this page only covers what's
particular to OneDrive.

**Platform note.** OneDrive is first-class on **Windows and macOS**, but Microsoft
ships **no official OneDrive client for Linux** — you bridge the gap with a third-party
tool (the `abraunegg` client, or rclone), which changes the offline guarantee (see
[Linux](#linux) below). If your Linux box is the priority, Dropbox is the only one of
the four providers with an official Linux client.

A privacy note specific to OneDrive: a **personal account vs. an employer's Microsoft
365 tenant** make a real difference — see the warnings below.

---

## Where OneDrive lives

This is the `$TARGET` you'd use in the manual appendix of the shared guide; `setup`
detects it automatically.

### macOS

OneDrive mounts under CloudStorage; the folder name depends on the account type:

```
~/Library/CloudStorage/OneDrive-Personal/        # personal account
~/Library/CloudStorage/OneDrive-<YourOrg>/        # work / school account
```

```bash
ONEDRIVE_ROOT="$(ls -d ~/Library/CloudStorage/OneDrive-* 2>/dev/null | head -1)"
TARGET="$ONEDRIVE_ROOT/claude-memory/-Users-$(whoami)"
```

With both a personal and a work OneDrive, set `ONEDRIVE_ROOT` explicitly rather than
relying on `head -1`, or pass `--account` (below).

### Windows

OneDrive sits under your user profile — `%UserProfile%\OneDrive\` (personal) or
`%UserProfile%\OneDrive - <YourOrg>\` (work/school). Keep the target near the OneDrive
root because of the 400-character path cap (see warnings).

```powershell
$TARGET = "$env:USERPROFILE\OneDrive\claude-memory\-Users-$env:USERNAME"
```

### Linux

Microsoft ships **no official OneDrive client for Linux**. Realistic options:

- **`abraunegg/onedrive`** (free, open source) — a maintained native sync client that
  keeps a real local copy of selected folders. The closest thing to the macOS/Windows
  experience and the most common Linux choice.
- **rclone** — `rclone bisync` to a real local directory is dependable; a plain
  `rclone mount` streams on demand, so use `--vfs-cache-mode full` and ensure files are
  cached, or the offline guarantee doesn't hold.

Point `$TARGET` at whatever local directory your tool keeps in sync, e.g.
`"$HOME/OneDrive/claude-memory/-home-$(whoami)"`.

### Multiple accounts

```sh
npx claude-memory-sync setup --provider onedrive --account OneDrive-Personal
```

---

## Make the folder available offline

OneDrive's **Files On-Demand** keeps files as **online-only** placeholders to save disk
space (on by default). When the memory folder is online-only, Claude follows the link,
finds placeholders, and reads no memory.

Status icons (same on macOS and Windows): **blue cloud** = online-only (avoid);
**green-outline check** = downloaded for now but may be freed later (not good enough);
**solid green circle with white check** = "Always keep on this device" (pinned, never
evicted — what you want).

### macOS / Windows

Right-click your `claude-memory` folder → **Always Keep on This Device**. New files in
a pinned folder download automatically; there's no global "never evict" toggle, so you
must pin the specific folder. Don't use **Free Up Space** on it.

On macOS, Files On-Demand is part of the OS since 12.1 and **cannot be turned off**, so
pinning is mandatory, not optional. (Windows has an undocumented `attrib +P` pin but
it's unreliable across versions — use the right-click menu.)

### Linux

No "Always keep on this device" menu, because there's no official client:

- **abraunegg client** keeps a real local copy of synced folders; make sure
  `claude-memory` is within your sync scope (everything, unless you use `sync_list`).
- **rclone bisync** to a real local folder is always readable; a plain `rclone mount`
  is only durably local with `--vfs-cache-mode full` *and* the file cached.

For a hard offline guarantee, keep a real local sync directory, not a bare VFS mount.

---

## Provider-specific warnings

- **Files On-Demand eviction is the main risk.** Storage Sense (Windows) or low disk
  space can quietly turn unused files back to online-only. **Always keep on this
  device** pins against that; on macOS it's required. Re-apply if needed.
  `npx claude-memory-sync doctor` checks for this.
- **Path-length cap (Windows).** OneDrive enforces a **400-character** limit on the
  total path (255 per segment). The `claude-memory/-Users-<name>` layout is short, but
  a deeply nested slug under a long org folder name (e.g. `OneDrive - <Long
  Organization Name>`) can approach it and sync will stall. Keep the target near the
  OneDrive root — `setup` warns if you're over the cap.
- **Linux has no official client.** The offline guarantee depends entirely on your
  abraunegg/rclone configuration. A bare rclone mount is not a durable local copy.
- **Work/school accounts may be governed.** A corporate Microsoft 365 tenant can apply
  retention, DLP, or admin-access policies to OneDrive content. If your memory holds
  anything personal, prefer a personal OneDrive (or a different provider) over an
  employer's tenant.
- **Links stay local.** OneDrive syncs the real files in `$TARGET`; the link in
  `~/.claude` is never synced — keep it there, not inside OneDrive.
- **Don't run two live sessions at once.** Simultaneous writes produce OneDrive
  conflict copies (e.g. `MEMORY-<MachineName>.md`). See
  [Concurrent writes](concurrent-writes.md).
