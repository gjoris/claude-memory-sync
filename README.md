# claude-memory-sync

Keep [Claude Code](https://docs.anthropic.com/en/docs/claude-code)'s file-based
memory in sync across the machines you work on — without copying files around by
hand.

Claude Code stores per-project memory as plain files on disk. That memory is
local, so the notes, preferences and context you build up on your laptop don't
exist on your desktop, and vice versa. `claude-memory-sync` fixes that by moving
the real memory directory into a folder your cloud client already syncs (Google
Drive, Dropbox, OneDrive, iCloud) and leaving a **symlink** behind. Claude Code
follows the symlink transparently and never knows the difference.

It runs on macOS, Linux and Windows from a single command. There's nothing to
install: run it with `npx`. On macOS and Linux it creates a symlink, on Windows
a directory junction (no administrator rights needed) — you use the same command
everywhere. See [Platform support](#platform-support) for the details and
caveats.

## How it works

Claude Code reads memory from a path derived from your working directory:

```
~/.claude/projects/<slug>/memory/
```

where `<slug>` is the current working directory with every `/` replaced by `-`.
For example, working in `/Users/geroen` gives the slug `-Users-geroen`, so memory
lives at `~/.claude/projects/-Users-geroen/memory/`.

Because the slug depends on your username and path, the location differs per
machine. The tool computes it from your live environment rather than hardcoding
it.

Setup does this, in order:

1. **Back up** the existing memory directory to a timestamped `.tar.gz` — before
   touching anything.
2. **Copy** the contents into `<cloud-root>/_SYSTEM/claude-memory/` (preserving
   attributes), then **verify** the file counts match.
3. **Move** the original directory aside to `memory.old` (never deleted) and
   **create a link** — a symlink on macOS/Linux, a directory junction on
   Windows — in its place pointing at the cloud folder.
4. **Confirm** read-through works.

The result: every machine you set up symlinks into the same synced folder, so
your Claude memory travels with you.

## Quick start

There's nothing to install — run it with `npx`, the same way on every OS. From
the directory you launch Claude Code in:

```sh
npx claude-memory-sync setup --provider google
#   ...or: --provider dropbox | onedrive | icloud
#   ...add --account <name> to pick a specific Google/OneDrive account.

npx claude-memory-sync status    # show current state
npx claude-memory-sync doctor    # health-check the link and cloud sync
npx claude-memory-sync merge --provider google --dry-run  # preview a merge
npx claude-memory-sync restore   # undo it (moves the data back, removes the link)
```

On Windows the same command creates a directory **junction** instead of a
symlink, so it needs no administrator rights. You don't pass anything different —
the tool picks the right link type for the platform.

Run `setup` once per machine, in the same working directory you launch Claude
Code from. The first machine seeds the cloud folder; the rest link into it. If a
later machine already has its own memory, `setup` **merges** the two sides
instead of overwriting (see [Merging two machines](#merging-two-machines)).

> Requires Node.js 18+ — which you already have if you run Claude Code.

## Merging two machines

The first machine you set up seeds the cloud folder. Every machine after that
just links into it — unless it already has its own local memory. When **both**
the local memory and the cloud target hold files, `setup` doesn't overwrite
either side: it **merges** them, after backing up both.

The merge is additive and non-destructive:

- **Local-only files** are copied into the cloud.
- **Cloud-only files** are left untouched.
- **Identical files** (same content) are left as-is.
- **Files that differ** are kept side-by-side: the cloud keeps the canonical
  name, and the local copy is saved as `<stem>.from-<host><ext>` (e.g.
  `notes.from-laptop.md`). Nothing is lost — you reconcile by hand later.
- **`MEMORY.md`** is merged line-by-line as a de-duplicated union (cloud lines
  first, then any local lines not already present), so the index from both
  machines survives.

To preview a merge without writing anything:

```sh
npx claude-memory-sync merge --provider google --dry-run
```

Drop `--dry-run` to apply it. `merge` reconciles the two sides **without**
relinking, so you can run it any time the cloud and a local directory have
drifted; `setup` runs the same merge automatically when it finds both sides
populated.

## Security and privacy — read this

This tool moves your **personal Claude memory off your machine and into a cloud
provider**. That memory can contain anything you've asked Claude to remember:
project details, names, preferences, account hints, internal context. Be honest
with yourself about that trade-off:

- Your cloud provider — and anyone with access to that account — can read these
  files. Treat the synced folder as exactly as trusted as the rest of that
  Drive.
- Use an account you actually control, with strong authentication (2FA) on it.
- If your memory contains secrets or client-confidential material, syncing it to
  a consumer cloud may not be acceptable. Consider a self-hosted/end-to-end
  encrypted sync target instead, or simply don't sync those projects.
- Nothing here is encrypted by the tool itself; it relies on your provider's
  transport and at-rest encryption.

If the privacy cost outweighs the convenience for a given project, don't sync
that project. The tool is per-working-directory, so you can be selective.

## Gotchas

### Online-only eviction (the big one)

Google Drive File Stream, OneDrive Files On-Demand, and iCloud's "Optimize Mac
Storage" can evict synced files to **cloud-only placeholders** to save disk.
When that happens, Claude opens the folder and sees an effectively empty
directory — your memory silently disappears.

The fix is to pin the folder so it stays downloaded — but the exact action
differs per provider, and none of them expose a reliable, documented CLI for it,
so it's a manual step in your file manager:

- **Google Drive** — set My Drive to **Mirror files** (not streaming + pin;
  streamed files are unavailable when the Drive app isn't running).
- **OneDrive** — right-click the folder → **Always keep on this device**.
- **iCloud** — Control-click → **Keep Downloaded** (`brctl download` only forces
  a one-time download, it does not pin).
- **Dropbox** — right-click → **Make available offline**.

`setup` prints the exact instruction for your provider, and `doctor` flags an
empty target or zero-byte placeholder files (including iCloud's `.icloud` stubs)
so you catch eviction early.

### Concurrent writes

Memory is just files in a synced folder, so two machines writing at the same
time can produce conflict copies like `MEMORY (1).md`. **Switch machines
sequentially** — don't run two live Claude sessions against the same memory at
once.

### Username / path divergence across machines

The memory path is built from `cwd` + username. If your username or working
directory differs between machines (e.g. `/Users/geroen` vs `/home/geroen`), the
slugs differ, and each machine links from its own path into the same shared
cloud folder. That's fine — just run `setup` on each machine from the directory
you actually use, and let the tool compute the slug for you.

## Platform support

All three desktop operating systems are first-class and run the **same command**
— `npx claude-memory-sync`. Node picks the right link type per platform, so
there's no separate installer to choose.

| OS      | Link mechanism                                 | Notes |
|---------|------------------------------------------------|-------|
| macOS   | symlink (`fs.symlink`, `dir`)                  | All four providers available. |
| Linux   | symlink (`fs.symlink`, `dir`)                  | Only Dropbox ships an official client. Google Drive, OneDrive and iCloud need third-party tooling (see below). |
| Windows | directory junction (`fs.symlink`, `junction`)  | Junction needs no admin rights. Keep paths under OneDrive's 400-character limit. |

### Linux caveat — official clients

Of the four providers, **only Dropbox has an official Linux client**. The other
three don't, and the workarounds change the offline guarantee this tool relies
on:

- **Google Drive** — no official client. Use [Insync](https://www.insynchq.com/)
  (paid) or [rclone](https://rclone.org/drive/). An rclone VFS mount is *not* a
  durable local copy unless it's cached (`--vfs-cache-mode full` with the file
  already pulled down), so the "always available offline" promise no longer holds
  by default.
- **OneDrive** — no official client. The community
  [abraunegg client](https://github.com/abraunegg/onedrive) or rclone are the
  usual options, with the same caching caveat.
- **iCloud Drive** — **no Linux client at all** (web-only). Not supported on
  Linux.

On macOS and Windows the mainline vendor clients cover all four providers.

## Guides

The universal flow — finding your memory path, running `setup`, pinning the
folder offline, and linking a second machine — is the same for every provider
and lives in one place:

- **[Setup guide](docs/setup.md)** — start here.

Then read the short companion page for your provider, which covers only what's
particular to it (where the cloud folder lives, the exact pin action, and the
per-provider warnings):

- [Google Drive](docs/google-drive.md)
- [Dropbox](docs/dropbox.md)
- [OneDrive](docs/onedrive.md)
- [iCloud Drive](docs/icloud.md)

## Safety guarantees

- A timestamped `.tar.gz` backup is written **before** any change.
- The original directory is moved to `*.old`, never deleted.
- The cloud copy and backups are **never** removed automatically — not even by
  `restore`. You clean those up yourself when you're confident.
- `setup` is idempotent: re-running when memory is already correctly linked does
  nothing.

## License

MIT — see [LICENSE](LICENSE).
