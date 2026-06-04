import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Claude Code reads memory from ~/.claude/projects/<slug>/memory, where <slug>
// is the current working directory with every path separator turned into "-".
// On POSIX "/Users/geroen" -> "-Users-geroen"; on Windows "C:\Users\geroen" ->
// "C:-Users-geroen". We replace both separators so the slug is stable however
// the cwd was spelled.
export function slugifyCwd(cwd = process.cwd()) {
  return cwd.replace(/[\\/]/g, "-");
}

// The per-project memory directory Claude Code reads from.
export function memoryPath(cwd = process.cwd(), home = os.homedir()) {
  return path.join(home, ".claude", "projects", slugifyCwd(cwd), "memory");
}

// The standard cloud target inside a provider's sync root.
export function cloudTarget(root) {
  return path.join(root, "_SYSTEM", "claude-memory");
}

// lstat without throwing. Returns the Stats object or null.
export function lstatSafe(p) {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}

// stat (follows symlinks) without throwing. Returns the Stats object or null.
export function statSafe(p) {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

// Is the path a symlink or (on Windows) a directory junction? Junctions report
// isSymbolicLink() === true from lstat on Node, so this covers both.
export function isLink(p) {
  const st = lstatSafe(p);
  return st ? st.isSymbolicLink() : false;
}

// Resolve a link to the directory it points at, or null if it does not resolve
// to a reachable directory. Anchors a relative target to the link's directory.
export function resolveLinkTarget(linkPath) {
  let raw;
  try {
    raw = fs.readlinkSync(linkPath);
  } catch {
    return null;
  }
  if (!raw) return null;
  const abs = path.isAbsolute(raw) ? raw : path.join(path.dirname(linkPath), raw);
  const st = statSafe(abs);
  if (st && st.isDirectory()) {
    try {
      return fs.realpathSync(abs);
    } catch {
      return abs;
    }
  }
  return null;
}

// The raw link target as stored (not resolved). Used for display / "points to".
export function readLinkRaw(linkPath) {
  try {
    return fs.readlinkSync(linkPath);
  } catch {
    return null;
  }
}

// Count regular files under a directory, recursively, following symlinks so it
// descends correctly when the dir itself is a link. Returns 0 if missing.
export function countFiles(dir) {
  const st = statSafe(dir);
  if (!st || !st.isDirectory()) return 0;
  let total = 0;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return total;
  }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    // Resolve through symlinks like `find -L`.
    const s = statSafe(full);
    if (!s) continue;
    if (s.isDirectory()) {
      total += countFiles(full);
    } else if (s.isFile()) {
      total += 1;
    }
  }
  return total;
}

// True if a directory exists and contains at least one entry.
export function dirHasEntries(dir) {
  const st = statSafe(dir);
  if (!st || !st.isDirectory()) return false;
  try {
    return fs.readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

// Create a directory link at linkPath pointing at target. On Windows this is a
// directory junction (no admin rights needed); on macOS/Linux a symlink. Node's
// fs.symlink "junction" type maps to a real symlink on POSIX and a junction on
// Windows, so one call covers all platforms — this is what removes the need for
// a separate PowerShell installer. Returns the kind created.
export function createDirLink(target, linkPath) {
  const type = process.platform === "win32" ? "junction" : "dir";
  fs.symlinkSync(target, linkPath, type);
  return process.platform === "win32" ? "junction" : "symlink";
}
