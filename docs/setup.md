# Setting up claude-memory-sync

This is the shared setup guide for all four providers. It covers everything that's
the same regardless of where you sync — finding your memory path, running the tool,
keeping the folder available offline, and linking a second machine.

Each provider has a short companion page for the bits that *are* provider-specific:
where the cloud folder lives, the exact "make available offline" action, and the
per-provider warnings. Read this page, then your provider's page:

- [Google Drive](google-drive.md)
- [Dropbox](dropbox.md)
- [OneDrive](onedrive.md)
- [iCloud Drive](icloud.md)

> A quick honesty note before you start: this copies your Claude Code memory (notes,
> preferences, anything Claude has remembered about you) into a cloud account. If
> that data is sensitive, decide consciously whether that provider is the right home
> for it. The mechanism itself is just a symlink (or, on Windows, a junction) and a
> synced folder — nothing leaves your machine that the cloud client wasn't already
> going to sync.

---

## 1. Find your Claude Code memory path

Claude Code stores memory per project, in a folder derived from the working directory
where you launch it:

```
~/.claude/projects/<slugified-cwd>/memory/
```

The slug is the absolute path with every `/` replaced by `-`. So if you run Claude
Code from your home folder `/Users/geroen`, the slug is `-Users-geroen` and the memory
lives at:

```
~/.claude/projects/-Users-geroen/memory/
```

This path is different on every machine, because it contains your username (and the
directory you work from). On a Mac where the user is `jdoe` it would be
`~/.claude/projects/-Users-jdoe/memory/`; on Linux the home root is `/home`, so the
slug is usually `-home-jdoe`; on Windows the user folder is `C:\Users\jdoe`. You don't
have to compute this by hand — `setup` derives it from your live environment — but
it's useful to recognise.

To see the projects that actually exist:

```bash
ls -d ~/.claude/projects/*/memory                       # macOS / Linux
```

```powershell
Get-ChildItem "$env:USERPROFILE\.claude\projects" -Directory |
  ForEach-Object { Join-Path $_.FullName 'memory' } | Where-Object { Test-Path $_ }
```

---

## 2. Set it up

From the directory you launch Claude Code in, run the one command — it's the same on
macOS, Linux and Windows:

```sh
npx claude-memory-sync setup --provider <google|dropbox|onedrive|icloud>
```

It auto-detects your cloud mount, computes the memory slug from your current
environment, backs up the existing memory directory (timestamped `.tar.gz`), copies
it into the cloud folder, verifies the file counts match, moves the original aside to
`memory.old` (never deleted), and replaces it with a link. On macOS and Linux that's
a symlink; on Windows it's a directory **junction** — no administrator rights needed,
and you don't pass anything different, the tool picks the right link type.

Re-running is safe: if the memory path is already linked to the cloud target it does
nothing. If you have more than one account signed in for a provider, point it at the
right one with `--account <name>` (see your provider page for the exact value).

Then **pin the folder offline** — this is the single most common way the setup
breaks, and the exact action differs per provider. `setup` prints the right
instruction for you; the details are in section 4 of your provider page.

The subcommands are the same everywhere:

```sh
npx claude-memory-sync status    # show whether memory is linked and where it points
npx claude-memory-sync doctor    # health-check the link and flag eviction / conflicts
npx claude-memory-sync restore   # undo: remove the link, move the data back
```

> Requires Node.js 18+ — which you already have if you run Claude Code.

---

## 3. Set it up on a second machine

Your memory is already in the cloud. On the new machine you only relink — you do
**not** copy again.

1. Install the provider's client and sign in with the same account (on Linux, set up
   your third-party sync of the same account — see your provider page).
2. Pin the `claude-memory` folder offline (section 4 of your provider page) so the
   files actually download.
3. From the directory you launch Claude Code in, run the same command:

   ```sh
   npx claude-memory-sync setup --provider <name>
   ```

Because the cloud folder is already populated, `setup` **merges** your local memory
into it instead of overwriting — see [Merging two machines](../README.md#merging-two-machines)
for exactly what that does. The folder name inside the cloud keeps the slug from the
machine that first created it; this machine links to it from its own (probably
different) slug. They don't have to match.

---

## 4. Concurrent writes

Memory is just files in a synced folder, so two machines writing at the same time can
produce provider conflict copies (e.g. `MEMORY (1).md`). **Switch machines
sequentially** — don't run two live Claude sessions against the same memory at once.

`npx claude-memory-sync doctor` scans for conflict copies after the fact and is the
real safety net. There's also an optional advisory soft-lock you can wire into Claude
Code's session hooks; see [Concurrent writes across machines](concurrent-writes.md).

---

## Appendix — the manual way

The `setup` command does all of this for you, but if you'd rather do it by hand (or
verify what the tool does), the steps are the same for every provider — only the
`$TARGET` path differs (section 2 of your provider page). `$MEM` is your memory path
from section 1 above.

**macOS / Linux:**

```bash
# 1. Back up, 2. copy into the cloud target, 3. verify counts match
tar -czf "$HOME/claude-memory-backup-$(date +%Y%m%d-%H%M%S).tar.gz" -C "$(dirname "$MEM")" "$(basename "$MEM")"
mkdir -p "$TARGET" && cp -a "$MEM/." "$TARGET/"
echo "source: $(find "$MEM" -type f | wc -l) files; target: $(find "$TARGET" -type f | wc -l) files"

# Only if the counts match — 4. move original aside and link, 5. confirm
mv "$MEM" "${MEM}.old" && ln -s "$TARGET" "$MEM"
ls -lah "$MEM"
```

**Windows (PowerShell)** — use a **junction** (no admin needed):

```powershell
# 1. Back up, 2. copy into the cloud target, 3. verify counts match
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
Compress-Archive -Path $MEM -DestinationPath "$env:USERPROFILE\claude-memory-backup-$stamp.zip"
New-Item -ItemType Directory -Force -Path $TARGET | Out-Null
Copy-Item -Path "$MEM\*" -Destination $TARGET -Recurse -Force
"source: $((Get-ChildItem $MEM -Recurse -File).Count) files; target: $((Get-ChildItem $TARGET -Recurse -File).Count) files"

# Only if the counts match — 4. move original aside and link, 5. confirm
Rename-Item -Path $MEM -NewName 'memory.old'
New-Item -ItemType Junction -Path $MEM -Target $TARGET
Get-Item $MEM | Format-List FullName, LinkType, Target
```

Keep both `memory.old` and the backup until you've run a real Claude Code session and
confirmed your memory is intact. To undo: `npx claude-memory-sync restore`, or
manually reverse step 4.

To verify every file is actually on disk (not an online-only placeholder):

```bash
find "$TARGET" -type f -print0 | xargs -0 ls -l >/dev/null && echo "all files readable locally"
```

```powershell
Get-ChildItem $TARGET -Recurse -File | ForEach-Object { [void](Get-Content $_.FullName -TotalCount 1) }; 'all files readable locally'
```
