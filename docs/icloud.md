# iCloud Drive

Provider-specific notes for syncing Claude Code memory with iCloud Drive. For the
universal flow — finding your memory path, running `setup`, linking a second machine —
read **[the shared setup guide](setup.md)** first; this page only covers what's
particular to iCloud.

**Platform note**, and it's the decisive one for iCloud:

- **macOS** is the only first-class platform. iCloud is best when all your machines are
  Macs.
- **Windows** works through the iCloud for Windows app, but with caveats — see below.
- **Linux** has **no iCloud client at all** (web-only, no synced local folder for a
  link to point at). **You cannot use iCloud for memory sync on Linux** — `setup
  --provider icloud` refuses to run there. Pick Dropbox, Google Drive, or OneDrive
  instead.

---

## Where iCloud Drive lives

This is the `$TARGET` you'd use in the manual appendix of the shared guide; `setup`
detects it automatically.

### macOS

In Finder it's **iCloud Drive**, but the real on-disk path is
`~/Library/Mobile Documents/com~apple~CloudDocs/`. That name does **not** change with
system language. Note the spaces and tildes — always quote the path.

```bash
ICLOUD_ROOT="$HOME/Library/Mobile Documents/com~apple~CloudDocs"
TARGET="$ICLOUD_ROOT/claude-memory/-Users-$(whoami)"
```

### Windows

iCloud for Windows surfaces iCloud Drive as a junction at `C:\Users\<username>\iCloudDrive`.

```powershell
$TARGET = "$env:USERPROFILE\iCloudDrive\claude-memory\-Users-$env:USERNAME"
```

Be honest about the Windows experience: iCloud for Windows is a weaker sync client than
the native Mac one. Pinning works in current versions (right-click → **Always keep on
this device**) but is missing in the older v7 client, and iCloud's handling of
links/placeholders on Windows is less predictable than Dropbox or OneDrive. If your
fleet is mixed Windows + Mac, this works; if you have a choice, the other three
providers are smoother on Windows.

---

## Make the folder available offline

With **Optimize Mac Storage** on, macOS can evict iCloud Drive files to cloud-only when
disk space runs low, leaving small `.icloud` placeholders. When that happens to the
memory folder, Claude follows the link, finds placeholders, and reads no memory.

### macOS

Control-click your `claude-memory` folder in Finder → **Keep Downloaded**. A downloaded
folder has no cloud/download icon; a cloud-with-down-arrow icon means cloud-only — the
state to avoid. (Don't use **Remove Download** on the memory folder.)

If a folder won't pin, download every file inside it first. A one-time `Download Now`
(or `brctl download "$TARGET"`) pulls files down but does **not** pin them — only **Keep
Downloaded** (or turning off Optimize Mac Storage) is a durable pin.

### Windows

In current iCloud for Windows, right-click your `claude-memory` folder in
`C:\Users\<you>\iCloudDrive` → **Always keep on this device**. This option does **not**
exist in the older v7 client — update first, or the folder may be evicted to online-only.

---

## Provider-specific warnings

- **Optimize Mac Storage eviction is the main risk.** It's the default on many Macs and
  silently turns idle files cloud-only. **Keep Downloaded** pins against it. Re-apply on
  every machine. `npx claude-memory-sync doctor` checks for `.icloud` placeholders. Note
  `brctl download` repairs an evicted state but is **not** a pin.
- **No Linux client at all.** iCloud Drive on Linux is web-only — no synced local
  folder, so this provider cannot be used for memory sync on Linux.
- **Windows is workable but second-class.** iCloud for Windows handles links and
  placeholders less predictably than Dropbox/OneDrive, and the pin option is missing in
  v7. For a smooth Windows + Mac fleet, the other three providers are easier.
- **iCloud and symlinks can be finicky.** iCloud doesn't reliably sync symlinks placed
  *inside* it, and the on-disk path contains spaces and `~` characters — always quote
  it. Our link lives in `~/.claude` (a junction on Windows) and points *into* iCloud, so
  it's never synced itself. Don't put the link inside iCloud Drive.
- **Sync can lag.** iCloud sometimes takes a while to push or pull changes, with no
  obvious progress. After editing memory on one machine, give it a moment to upload
  before switching.
- **Don't run two live sessions at once.** Simultaneous writes can create conflict
  copies or, worse, a silent last-writer-wins overwrite. See
  [Concurrent writes](concurrent-writes.md).
