import fs from "node:fs";
import path from "node:path";
import { info, note, ok, warn, err } from "./ui.js";

// A true cross-machine lock is impossible: cloud sync is eventually-consistent
// and this tool is not in Claude's read/write path. So when two machines write
// the same memory at once, the provider drops a *conflict copy* next to the
// original. We cannot prevent that, but doctor can find them and walk the user
// through a safe manual merge. We never auto-delete or merge.

// Work out the canonical file a conflict copy likely belongs to by stripping the
// provider's marker. Returns the canonical basename, or null if the name does
// not look like a known conflict pattern.
export function canonicalForConflict(base) {
  const idx = base.lastIndexOf(".");
  let stem, ext;
  if (idx > 0) {
    stem = base.slice(0, idx);
    ext = base.slice(idx);
  } else {
    stem = base;
    ext = "";
  }

  let name = "";
  if (/ \([0-9]\)$/.test(stem)) {
    // Google Drive / iCloud "<name> (1)"
    name = stem.replace(/ \([0-9]\)$/, "");
  } else if (stem.includes("conflicted copy")) {
    // Dropbox "<name> (<host>'s conflicted copy <date>)"
    if (stem.includes(" (")) name = stem.slice(0, stem.lastIndexOf(" ("));
    else name = stem.slice(0, stem.indexOf("conflicted copy")).replace(/ $/, "");
  } else if (stem.includes("(conflicted)")) {
    // OneDrive / generic "(conflicted)" marker
    name = stem.slice(0, stem.indexOf("(conflicted)")).replace(/ $/, "");
  } else if (/ 2$/.test(stem)) {
    // iCloud-style " 2" suffix (caller verifies the sibling exists)
    name = stem.replace(/ 2$/, "");
  } else if (stem.includes("-")) {
    // OneDrive machine-suffix "<name>-<HOST>" (caller verifies sibling exists)
    name = stem.slice(0, stem.lastIndexOf("-"));
  } else {
    return null;
  }

  if (!name) return null;
  return name + ext;
}

function looksLikeConflict(base) {
  if (/ \([0-9]\)(\..+)?$/.test(base)) return true; // Google/iCloud (N)
  if (base.includes("conflicted copy")) return true; // Dropbox
  if (base.includes("(conflicted)")) return true; // OneDrive/generic
  // Looser machine-suffix / " 2": treated as a candidate, verified by sibling.
  if (/-.+(\..+)?$/.test(base) || / 2(\..+)?$/.test(base)) return true;
  return false;
}

function hasExplicitMarker(base) {
  return base.includes("conflicted copy") || base.includes("(conflicted)");
}

function shortDiff(canonPath, conflictPath) {
  try {
    const a = fs.readFileSync(canonPath, "utf8").split("\n");
    const b = fs.readFileSync(conflictPath, "utf8").split("\n");
    const lines = [];
    const max = Math.max(a.length, b.length);
    for (let i = 0; i < max && lines.length < 40; i++) {
      if (a[i] !== b[i]) {
        if (a[i] !== undefined) lines.push(`< ${a[i]}`);
        if (b[i] !== undefined) lines.push(`> ${b[i]}`);
      }
    }
    return lines.slice(0, 40);
  } catch {
    return [];
  }
}

// Scan a directory for conflict copies and report each against its canonical
// sibling. Returns the number of UNRESOLVED conflicts (content differs).
export function detectConflictCopies(dir) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return 0;
  let unresolved = 0;
  let found = 0;

  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));

  for (const ent of entries) {
    if (!ent.isFile()) continue;
    const base = ent.name;
    if (base === "LOCK") continue;
    if (!looksLikeConflict(base)) continue;

    const canon = canonicalForConflict(base);
    if (!canon || canon === base) continue;
    const canonPath = path.join(dir, canon);
    const fPath = path.join(dir, base);

    // For the loose machine-suffix / " 2" heuristics, require the canonical
    // sibling to exist (unless an explicit marker is present).
    if (!fs.existsSync(canonPath) && !hasExplicitMarker(base)) continue;

    found += 1;

    const canonIsFile = fs.existsSync(canonPath) && fs.statSync(canonPath).isFile();
    let identical = false;
    if (canonIsFile) {
      try {
        identical = fs.readFileSync(fPath).equals(fs.readFileSync(canonPath));
      } catch {
        identical = false;
      }
    }

    if (canonIsFile && identical) {
      warn(`[warn] conflict copy detected: ${base}`);
      info(`       canonical file:  ${canon}`);
      warn(`       contents are IDENTICAL to '${canon}' — safe duplicate.`);
    } else {
      err(`[FAIL] conflict copy detected: ${base}`);
      info(`       canonical file:  ${canon}`);
    }

    if (canonIsFile) {
      if (identical) {
        note("       Safe to delete the duplicate once you have confirmed:");
        note(`         rm -- "${fPath}"`);
      } else {
        err(`       contents DIFFER from '${canon}' — unresolved conflict.`);
        unresolved += 1;
        info("       --- diff (canonical '<' vs conflict '>') ---");
        for (const line of shortDiff(canonPath, fPath)) info(`       ${line}`);
        info("       --------------------------------------------");
        note("       Resolve it by hand (doctor never edits your files):");
        note(`         (a) inspect both:   diff "${canonPath}" "${fPath}"`);
        note(`         (b) keep canonical, or: cp "${fPath}" "${canonPath}"`);
        note(`             or merge by editing "${canonPath}" to combine both.`);
        note("         (c) once merged, remove the conflict file:");
        note(`             rm -- "${fPath}"`);
      }
    } else {
      warn(`       canonical '${canon}' is missing; this copy may be the only survivor.`);
      note("       If this is the file you want, rename it back into place:");
      note(`         mv -- "${fPath}" "${canonPath}"`);
    }
    info("");
  }

  if (found === 0) {
    ok("[ok]   no cloud-sync conflict copies found.");
  }
  return unresolved;
}

// Surface a stale advisory soft-lock (from the optional `lock` feature) so the
// user can clear it. Only fires if a LOCK file is actually present.
export function detectStaleLock(dir) {
  const lock = path.join(dir, "LOCK");
  if (!fs.existsSync(lock) || !fs.statSync(lock).isFile()) return;

  let host = "";
  let stamp = "";
  try {
    for (const line of fs.readFileSync(lock, "utf8").split(/\r?\n/)) {
      if (line.startsWith("host=")) host = line.slice(5);
      else if (line.startsWith("acquired=")) stamp = line.slice(9);
    }
  } catch {
    /* ignore */
  }

  warn(`[warn] an advisory soft-lock exists: ${lock}`);
  if (host) info(`       held by host: ${host}`);
  if (stamp) info(`       written at:   ${stamp}`);
  warn("       This is the opt-in soft-lock. It is advisory only and never");
  warn("       blocks Claude. If no session is actually active (e.g. a crash");
  warn("       left it behind), it is stale — clear it with:");
  note(`         rm -- "${lock}"`);
}
