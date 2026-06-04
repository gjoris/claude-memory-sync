import fs from "node:fs";
import path from "node:path";
import { info, note, ok, warn, err, die, banner, colors } from "./ui.js";
import {
  memoryPath,
  cloudTarget,
  countFiles,
  dirHasEntries,
  isLink,
  readLinkRaw,
  resolveLinkTarget,
  statSafe,
  lstatSafe,
  createDirLink,
} from "./paths.js";
import {
  PROVIDERS,
  ONEDRIVE_PATH_CAP,
  providerLabel,
  providerRoot,
  ProviderError,
  offlineInstruction,
  isRcloneMount,
} from "./providers.js";
import { backupDir, timestamp } from "./backup.js";
import { doMerge, mergeSummary } from "./merge.js";
import { detectConflictCopies, detectStaleLock } from "./conflicts.js";

function validateProvider(provider) {
  if (!provider) {
    die("requires --provider <google|dropbox|onedrive|icloud>");
  }
  if (!PROVIDERS.includes(provider)) {
    die(`unknown provider '${provider}' (expected ${PROVIDERS.join("|")})`);
  }
}

// Resolve a provider's cloud target, surfacing fatal ProviderErrors cleanly and
// returning { target, warning }.
function resolveTarget(provider, account) {
  let res;
  try {
    res = providerRoot(provider, account);
  } catch (e) {
    if (e instanceof ProviderError) {
      die(e.message);
    }
    throw e;
  }
  if (!res.root) {
    die(`could not locate ${providerLabel(provider)} mount. Is the client installed and signed in?`);
  }
  return { target: cloudTarget(res.root), root: res.root, warning: res.warning };
}

function printOfflineStep(provider) {
  banner("MANUAL STEP REQUIRED — pin the folder offline");
  warn("Cloud clients can evict synced files to 'online-only', leaving Claude an");
  warn("empty directory. This usually CANNOT be forced from the terminal, so do");
  warn("it now in your file manager:");
  info("");
  info(offlineInstruction(provider));
  info("");
  note("Then run 'claude-memory-sync doctor' to confirm nothing is online-only.");
}

// --- setup ------------------------------------------------------------------

export function cmdSetup({ provider, account }) {
  validateProvider(provider);
  const label = providerLabel(provider);
  const mem = memoryPath();
  const { target, root, warning } = resolveTarget(provider, account);

  info(`Provider:     ${colors.BOLD}${label}${colors.RESET}`);
  info(`Sync root:    ${root}`);
  info(`Memory path:  ${mem}`);
  info(`Cloud target: ${target}`);
  info("");

  if (warning) {
    banner("HEADS UP — provider caveat");
    warn(warning);
    info("");
  }

  if (process.platform === "win32" && target.length > ONEDRIVE_PATH_CAP && provider === "onedrive") {
    warn(`Cloud target path is ${target.length} chars, over OneDrive's ${ONEDRIVE_PATH_CAP}-char limit.`);
    warn("Consider a shorter working directory to keep within the cap.");
    info("");
  }

  // Idempotency: already a symlink?
  if (isLink(mem)) {
    const cur = resolveLinkTarget(mem);
    const raw = readLinkRaw(mem);
    // The cloud target may not exist yet, so realpath it defensively — a missing
    // path can't match anyway, and a foreign link must fall through to the
    // "points elsewhere" branch rather than crash here.
    let targetReal = target;
    try {
      targetReal = fs.realpathSync(target);
    } catch {
      /* target not created yet; leave as the literal path */
    }
    if (cur === targetReal || raw === target) {
      ok("Already set up: memory is a symlink to the cloud target. Nothing to do.");
      printOfflineStep(provider);
      return;
    }
    warn("memory is a symlink, but points elsewhere:");
    warn(`  current: ${raw}`);
    warn(`  desired: ${target}`);
    die("refusing to change an existing symlink automatically. Run 'restore' first, or fix it by hand.");
  }

  fs.mkdirSync(target, { recursive: true });

  const memStat = lstatSafe(mem);
  if (memStat && memStat.isDirectory()) {
    const srcCount = countFiles(mem);
    const targetCount = countFiles(target);

    const stamp = timestamp();
    const backup = `${mem}.backup-${stamp}.tar.gz`;
    info(`Backing up current memory (${srcCount} files) -> ${backup}`);
    try {
      backupDir(mem, backup);
    } catch (e) {
      die(`backup failed (${e.message}); aborting before any change.`);
    }
    ok(`Backup written: ${backup}`);

    if (targetCount > 0) {
      // Both sides populated: MERGE instead of copy+count-verify.
      info(`Cloud target already has ${targetCount} files — merging instead of overwriting.`);
      const cloudBackup = `${target}.backup-${stamp}.tar.gz`;
      info(`Backing up cloud target (${targetCount} files) -> ${cloudBackup}`);
      try {
        backupDir(target, cloudBackup);
      } catch (e) {
        die(`cloud-side backup failed (${e.message}); aborting. Local backup at ${backup}.`);
      }
      ok(`Cloud backup written: ${cloudBackup}`);

      const result = doMerge(mem, target, "apply");
      ok(mergeSummary(result));
      ok(`Local backup kept at: ${backup}`);
      ok(`Cloud backup kept at: ${cloudBackup}`);
    } else {
      // Cloud target empty: copy + verify.
      info("Copying memory into cloud target...");
      copyDirContents(mem, target);
      const dstCount = countFiles(target);
      if (srcCount !== dstCount) {
        die(`file count mismatch after copy (source=${srcCount}, target=${dstCount}). Original untouched, backup at ${backup}.`);
      }
      ok(`Verified: ${dstCount} files copied.`);
    }

    // Move original aside (never deleted), then link.
    let old = `${mem}.old`;
    if (fs.existsSync(old)) old = `${mem}.old-${stamp}`;
    try {
      fs.renameSync(mem, old);
    } catch (e) {
      die(`could not move original aside (${e.message}); nothing linked yet, backup at ${backup}.`);
    }
    try {
      createDirLink(target, mem);
    } catch (e) {
      die(`link creation failed (${e.message}); your data is safe at ${old} and in the cloud target.`);
    }
    ok(`Linked: ${mem} -> ${target}`);
    info(`Original kept at: ${old}`);
    info(`Backup kept at:   ${backup}`);
  } else {
    info("No existing memory directory found; creating a fresh link.");
    fs.mkdirSync(path.dirname(mem), { recursive: true });
    try {
      createDirLink(target, mem);
    } catch (e) {
      die(`link creation failed (${e.message}).`);
    }
    ok(`Linked: ${mem} -> ${target}`);
  }

  // Read-through sanity check.
  const st = statSafe(mem);
  if (st && st.isDirectory()) {
    ok(`Read-through OK: ${countFiles(mem)} files visible via the link.`);
  } else {
    warn("Link created but target is not readable yet (provider may still be syncing).");
  }

  printOfflineStep(provider);
}

function copyDirContents(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name);
    const d = path.join(dst, ent.name);
    const st = fs.statSync(s);
    if (st.isDirectory()) copyDirContents(s, d);
    else if (st.isFile()) fs.copyFileSync(s, d);
  }
}

// --- status -----------------------------------------------------------------

export function cmdStatus() {
  const mem = memoryPath();
  info(`Memory path: ${mem}`);

  if (isLink(mem)) {
    const raw = readLinkRaw(mem);
    ok("State:       symlink/junction");
    info(`Points to:   ${raw}`);
    const st = statSafe(mem);
    if (st && st.isDirectory()) {
      ok("Target:      reachable");
      info(`File count:  ${countFiles(mem)}`);
    } else {
      err("Target:      NOT reachable (broken link or cloud folder missing)");
    }
    return;
  }

  const lst = lstatSafe(mem);
  if (lst && lst.isDirectory()) {
    warn("State:       real directory (not yet synced)");
    info(`File count:  ${countFiles(mem)}`);
    note("Run 'claude-memory-sync setup --provider <name>' to relocate it to the cloud.");
  } else if (lst) {
    warn("State:       exists but is neither a link nor a directory");
  } else {
    warn("State:       missing (no memory directory at this path)");
  }
}

// --- doctor -----------------------------------------------------------------

export function cmdDoctor({ provider } = {}) {
  const mem = memoryPath();
  info(`Checking: ${mem}`);
  info("");

  let problems = 0;

  if (isLink(mem)) {
    const raw = readLinkRaw(mem);
    const st = statSafe(mem);
    if (st && st.isDirectory()) {
      ok(`[ok]   link resolves to a reachable directory (${raw})`);
    } else {
      err(`[FAIL] link is broken: target '${raw}' is not reachable`);
      problems += 1;
    }
  } else if (lstatSafe(mem)?.isDirectory()) {
    warn("[warn] memory is still a real directory (not synced). Run 'setup'.");
  } else {
    err(`[FAIL] no memory found at ${mem}`);
    problems += 1;
  }

  const st = statSafe(mem);
  if (st && st.isDirectory()) {
    const total = countFiles(mem);
    const zero = countZeroByteFiles(mem);
    if (total === 0) {
      err("[FAIL] target directory is EMPTY — likely fully evicted to cloud-only.");
      problems += 1;
    } else if (zero > 0) {
      warn(`[warn] ${zero} of ${total} files are zero-byte — possible online-only placeholders.`);
      warn("       If these should have content, pin the folder offline (see below).");
      problems += 1;
    } else {
      ok(`[ok]   ${total} files present, none zero-byte (no obvious eviction).`);
    }
  }

  // Linux rclone caveat: a VFS mount can report full size with no local data.
  if (process.platform === "linux" && isLink(mem)) {
    const tgt = resolveLinkTarget(mem);
    if (tgt && isRcloneMount(tgt)) {
      warn(`[warn] target '${tgt}' is on an rclone mount. Files can show as present`);
      warn("       and full-sized while their data is NOT cached locally; this tool");
      warn("       cannot confirm a durable local copy. Run rclone with");
      warn("       --vfs-cache-mode full and make sure this folder is cached.");
    }
  }

  if (st && st.isDirectory()) {
    info("");
    const unresolved = detectConflictCopies(mem);
    problems += unresolved;
    detectStaleLock(mem);
  }

  info("");
  let prov = provider;
  if (!prov && isLink(mem)) {
    const raw = readLinkRaw(mem) || "";
    if (raw.includes("GoogleDrive")) prov = "google";
    else if (raw.includes("OneDrive")) prov = "onedrive";
    else if (raw.includes("CloudDocs")) prov = "icloud";
    else if (raw.includes("Dropbox")) prov = "dropbox";
  }
  banner("Keep this folder pinned offline");
  info(offlineInstruction(prov || "unknown"));

  if (problems > 0) {
    info("");
    warn(`doctor found ${problems} issue(s) above.`);
    process.exitCode = 1;
    return;
  }
  info("");
  ok("doctor: all checks passed.");
}

function countZeroByteFiles(dir) {
  let count = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const full = path.join(d, ent.name);
      const s = statSafe(full);
      if (!s) continue;
      if (s.isDirectory()) stack.push(full);
      else if (s.isFile() && s.size === 0) count += 1;
    }
  }
  return count;
}

// --- restore ----------------------------------------------------------------

export function cmdRestore() {
  const mem = memoryPath();

  if (!isLink(mem)) {
    if (lstatSafe(mem)?.isDirectory()) {
      die("memory is already a real directory; nothing to restore.");
    }
    die(`memory is not a link; nothing to restore at ${mem}`);
  }

  const tgt = resolveLinkTarget(mem) || readLinkRaw(mem);

  // Newest matching .old / .old-<stamp> directory.
  let old = "";
  let oldMtime = -1;
  const parent = path.dirname(mem);
  const baseName = path.basename(mem);
  try {
    for (const name of fs.readdirSync(parent)) {
      if (name === `${baseName}.old` || name.startsWith(`${baseName}.old-`)) {
        const full = path.join(parent, name);
        const s = statSafe(full);
        if (s && s.isDirectory() && s.mtimeMs > oldMtime) {
          old = full;
          oldMtime = s.mtimeMs;
        }
      }
    }
  } catch {
    /* ignore */
  }

  try {
    fs.rmSync(mem, { force: true });
  } catch (e) {
    die(`could not remove the link at ${mem} (${e.message})`);
  }

  if (old) {
    info(`Restoring from local backup directory: ${old}`);
    try {
      fs.renameSync(old, mem);
    } catch (e) {
      die(`could not move '${old}' back to '${mem}' (${e.message}). Link removed; data is at '${old}' and '${tgt}'.`);
    }
    ok(`Restored: ${mem} is a real directory again (${countFiles(mem)} files).`);
  } else {
    info("No .old directory found; copying data back from the cloud target.");
    fs.mkdirSync(mem, { recursive: true });
    if (tgt && dirHasEntries(tgt)) {
      copyDirContents(tgt, mem);
    }
    ok(`Restored from cloud: ${mem} (${countFiles(mem)} files).`);
  }

  info("");
  note(`The cloud copy at '${tgt}' was left in place (not deleted).`);
  note("Any *.tar.gz backups and *.old dirs are kept — remove them yourself when happy.");
}

// --- merge ------------------------------------------------------------------

export function cmdMerge({ provider, account, dryRun }) {
  const mem = memoryPath();

  if (isLink(mem)) {
    ok("memory is already a link to the cloud target — nothing to merge.");
    return;
  }
  if (!lstatSafe(mem)?.isDirectory()) {
    die(`no local memory directory at ${mem}; nothing to merge.`);
  }

  validateProvider(provider);
  const { target } = resolveTarget(provider, account);

  info(`Local memory: ${mem}`);
  info(`Cloud target: ${target}`);
  info("");

  if (!statSafe(target)?.isDirectory() || countFiles(target) === 0) {
    warn("cloud target is empty or missing; nothing to merge against.");
    note(`Run 'claude-memory-sync setup --provider ${provider}' to relocate this memory to the cloud.`);
    return;
  }

  if (dryRun) {
    note("Dry run — planned actions (nothing will be written):");
    const result = doMerge(mem, target, "dry");
    info("");
    info(`Plan totals: ${result.copied} to copy, ${result.unioned} to union, ${result.keptBoth} to keep-both.`);
    return;
  }

  const stamp = timestamp();
  const backup = `${mem}.backup-${stamp}.tar.gz`;
  info(`Backing up local memory -> ${backup}`);
  try {
    backupDir(mem, backup);
  } catch (e) {
    die(`local backup failed (${e.message}); aborting before any change.`);
  }
  ok(`Local backup written: ${backup}`);

  const cloudBackup = `${target}.backup-${stamp}.tar.gz`;
  info(`Backing up cloud target -> ${cloudBackup}`);
  try {
    backupDir(target, cloudBackup);
  } catch (e) {
    die(`cloud-side backup failed (${e.message}); aborting. Local backup at ${backup}.`);
  }
  ok(`Cloud backup written: ${cloudBackup}`);

  const result = doMerge(mem, target, "apply");
  ok(mergeSummary(result));
  ok(`Local backup kept at: ${backup}`);
  ok(`Cloud backup kept at: ${cloudBackup}`);
}
