# Concurrent writes across machines

Once your Claude Code memory lives in a cloud-synced folder, it is reachable from
every machine you set up. That is the whole point — but it also means two machines
can, in principle, write to the same memory at the same time. This page is an honest
account of what can go wrong, what this project does about it, and what it
deliberately does **not** pretend to do.

## The problem

Cloud storage (Google Drive, Dropbox, OneDrive, iCloud) is **eventually
consistent**. When you save a file, the provider uploads it and then pushes it to
your other machines after some delay — seconds, sometimes minutes, longer if a
machine was asleep or offline. There is no global, instantaneous view of "the
current file".

So if two machines edit the same memory file before sync has reconciled them, the
provider cannot merge them. Instead it keeps both and renames one. You end up with a
**conflict copy** sitting next to the real file.

### Why a true lock is impossible here

A real lock would need a single authority that every machine checks before writing,
synchronously. We have neither:

1. **The store is eventually consistent.** A "lock file" written on machine A may
   not have reached machine B yet when B starts. By the time B sees it, both have
   already written.
2. **This tool is not in Claude's read/write path.** `claude-memory-sync` only sets
   up the symlink (a junction on Windows). After that, Claude Code reads and writes
   the memory files **directly**, live, through that link. Nothing we ship sits
   between Claude and the filesystem to intercept a write and check a lock.

Anyone promising a cross-machine lock on top of consumer cloud sync is hand-waving.
We would rather be straight with you.

## The two honest layers

Instead of a fake lock, this project does two real things.

### Layer 1 — Reactive: conflict detection in `doctor` (the real safety net)

`claude-memory-sync doctor` scans your synced memory folder for the conflict files
that providers leave behind, lists them, and helps you compare and merge them back
into the canonical file. This works **regardless of sync timing** — it inspects what
actually landed on disk, so it catches the real-world case every time, after the
fact. **This is the layer you should rely on.**

Conflict-file name patterns you may see, by provider:

| Provider     | Typical conflict-copy pattern                                              |
|--------------|----------------------------------------------------------------------------|
| Google Drive | `MEMORY (1).md`, `MEMORY (2).md` (a parenthesised counter is appended)     |
| Dropbox      | `MEMORY (NAME's conflicted copy 2026-05-30).md` / `…conflicted copy…`      |
| OneDrive     | `MEMORY-DESKTOP-AB12CD.md` (machine name suffix), or `MEMORY (user's conflicted copy).md` |
| iCloud Drive | `MEMORY 2.md`, or a versioned variant Apple keeps when it can't reconcile  |

If `doctor` finds any of these, open both files, reconcile by hand, and delete the
conflict copy once you are happy. Your edits are never silently lost — the provider
keeps both sides precisely so you can choose.

### Layer 2 — Proactive: an OPTIONAL advisory soft-lock (opt-in)

This is a courtesy heads-up, not a guarantee. If you enable it (below), Claude Code
writes a small `LOCK` file into the cloud memory folder when a session starts, and
removes it when the session ends. If a session starts and finds a **fresh** `LOCK`
from a **different** machine, it prints a warning so you can think twice before
running two live sessions at once.

It is **advisory only**:

- It **never blocks** Claude and never fails your session — at worst it prints a line
  to stderr.
- The sync race still exists: a `LOCK` from the other machine may not have
  propagated to yours yet, so absence of a warning does not prove you are alone.

Because of those limits, Layer 1 (`doctor`) remains the real safety net. Layer 2 just
nudges you toward the sequential-machine-switching habit that avoids conflicts in the
first place.

## Enabling the optional hooks

The soft-lock is built into the tool itself, as a `lock` subcommand that takes a
single argument, `acquire` or `release`. You wire it to Claude Code's
**SessionStart** and **SessionEnd** (or **Stop**) hook events in
`~/.claude/settings.json`. The same command works on every platform — there's no
separate script to copy or keep executable.

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "npx claude-memory-sync lock acquire"
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "npx claude-memory-sync lock release"
          }
        ]
      }
    ]
  }
}
```

If your Claude Code build does not emit `SessionEnd`, use the `Stop` event instead —
swap the `"SessionEnd"` key for `"Stop"` and keep the same `release` command. The
same JSON works on macOS, Linux and Windows.

> `npx` resolves the package from its cache after the first run, so the hook adds
> negligible startup cost. If you'd rather avoid even that, install the tool once
> (`npm i -g claude-memory-sync`) and use the bare `claude-memory-sync lock …`
> command in the hook instead.

The `lock` subcommand only acts when memory is already a set-up link, and it never
throws — a hook can never break your session.

## TTL and stale locks

A crash, a force-quit, or a machine that never reaches the `release` hook will leave
a `LOCK` behind. To stop a dead lock from warning forever, the lock has a **time to
live**: any `LOCK` older than the TTL is treated as **stale** and silently ignored
(and overwritten by the next session that starts).

- Default TTL: **8 hours**.
- Override it by setting `CLAUDE_MEMORY_LOCK_TTL_HOURS` in the environment the hook
  runs in. For example, `CLAUDE_MEMORY_LOCK_TTL_HOURS=2` shortens it to two hours.

Freshness is judged from the `LOCK` file's modification time, so a stale lock simply
ages out — you do not have to do anything for the common case.

### The lock file

The `LOCK` lives **inside the cloud memory directory** (the real folder your symlink
points at), so it syncs along with your memory. It is two human-readable lines:

```
host=my-laptop
acquired=2026-05-30T13:45:09Z
```

`release` only deletes the lock if its `host` line matches the current machine, so a
machine never removes another machine's lock.

### Clearing a stale lock manually

You normally don't need to — stale locks age out on their own. But if you want to
clear one immediately, just delete the `LOCK` file from the synced memory folder. To
find that folder, ask the installer where your memory points:

```sh
npx claude-memory-sync status     # prints "Points to: <cloud dir>"
```

Then remove the file (and let it sync):

```bash
rm "<cloud dir>/LOCK"          # macOS / Linux
```

```powershell
Remove-Item "<cloud dir>\LOCK" # Windows
```

Deleting the lock is always safe: it is advisory metadata, never your memory data.

## In one sentence

The advisory soft-lock is a polite warning that helps you keep your
sequential-machine habit; `doctor`'s conflict detection (Layer 1) is the actual
safety net that catches anything the warning misses.
