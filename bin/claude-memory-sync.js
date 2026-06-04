#!/usr/bin/env node
import { cmdSetup, cmdStatus, cmdDoctor, cmdRestore, cmdMerge } from "../lib/commands.js";
import { runLock } from "../lib/lock.js";
import { info, err } from "../lib/ui.js";

// Survive a closed pipe (e.g. `claude-memory-sync doctor | head`) without a
// noisy EPIPE stack trace — just stop writing and exit.
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (e) => {
    if (e && e.code === "EPIPE") process.exit(0);
    throw e;
  });
}

// Parse "--flag value", "--flag=value", and bare positionals. Returns
// { _: [positionals], flags: { name: value|true } }.
function parseArgs(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const body = arg.slice(2);
      const eq = body.indexOf("=");
      if (eq !== -1) {
        out.flags[body.slice(0, eq)] = body.slice(eq + 1);
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
        out.flags[body] = argv[++i];
      } else {
        out.flags[body] = true;
      }
    } else {
      out._.push(arg);
    }
  }
  return out;
}

function usage() {
  info(`claude-memory-sync — keep Claude Code's memory in sync across machines via a cloud folder + link.

USAGE
  npx claude-memory-sync setup --provider <google|dropbox|onedrive|icloud> [--account <name>]
  npx claude-memory-sync merge --provider <google|dropbox|onedrive|icloud> [--account <name>] [--dry-run]
  npx claude-memory-sync status
  npx claude-memory-sync doctor
  npx claude-memory-sync restore
  npx claude-memory-sync lock <acquire|release>
  npx claude-memory-sync --help

SUBCOMMANDS
  setup     Relocate the current project's memory directory into your cloud
            folder and replace it with a symlink (macOS/Linux) or directory
            junction (Windows). Backs up first (.tar.gz), verifies file counts,
            keeps the original as <memory>.old. Idempotent. When BOTH the local
            memory and the cloud target already hold files, setup MERGES them
            additively instead of overwriting, backing up both sides first.
  merge     Reconcile the current machine's local memory against the cloud
            target without relinking: local-only files copied in, identical
            files left alone, differing files kept side-by-side as
            <stem>.from-<host><ext>, MEMORY.md merged as a de-duplicated line
            union. Backs up both sides first. --dry-run prints the plan only.
  status    Show whether memory is a link, where it points, the file count, and
            whether the target is reachable.
  doctor    Check link health and online-only eviction risk (empty target /
            zero-byte placeholders), scan for cloud-sync conflict copies, and
            print the provider's manual "make available offline" instruction.
  restore   Reverse setup: remove the link and move the cloud data back into
            place. Never deletes the cloud copy or your backups.
  lock      Optional advisory soft-lock for Claude Code hooks (SessionStart ->
            acquire, SessionEnd/Stop -> release). Advisory only; never blocks.

HOW IT WORKS
  Claude Code reads memory from ~/.claude/projects/<slug>/memory, where <slug>
  is the current working directory with every separator turned into "-". This
  is computed from your live cwd, so it is correct on each machine.

NOTES
  - The manual "make available offline" step generally cannot be forced from the
    CLI; do it in your file manager after setup (the tool reminds you).
  - Don't run two live sessions against the same memory at once — concurrent
    writes from two machines create conflict copies. Switch machines
    sequentially. 'doctor' detects any conflict copies after the fact.

PLATFORMS
  One codebase for macOS, Linux and Windows (Node's fs.symlink "junction" type
  becomes a junction on Windows, a symlink on POSIX). On Linux only Dropbox
  ships an official client; Google Drive and OneDrive fall back to a detected
  third-party mount (rclone, Insync, abraunegg) with a caveat, and iCloud is
  refused (no Linux client).`);
}

function main() {
  const argv = process.argv.slice(2);
  const { _, flags } = parseArgs(argv);
  const sub = _[0];

  switch (sub) {
    case "setup":
      cmdSetup({ provider: flags.provider, account: flags.account });
      break;
    case "merge":
      cmdMerge({ provider: flags.provider, account: flags.account, dryRun: !!flags["dry-run"] });
      break;
    case "status":
      cmdStatus();
      break;
    case "doctor":
      cmdDoctor({ provider: flags.provider });
      break;
    case "restore":
      cmdRestore();
      break;
    case "lock":
      runLock(_[1]);
      break;
    case "-h":
    case "--help":
    case "help":
    case undefined:
      usage();
      break;
    default:
      err(`unknown command: ${sub}`);
      info("");
      usage();
      process.exit(1);
  }
}

main();
