import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { info } from "./ui.js";

// When both the local memory dir and the cloud target hold files, copying one
// over the other loses data. So we MERGE per top-level file (the memory dir is
// flat — top-level .md files and MEMORY.md; we never recurse):
//   - local-only      -> copy into cloud.
//   - cloud-only       -> leave.
//   - identical        -> no-op.
//   - both differing   -> keep-both: cloud keeps the canonical name, the local
//                         copy is written beside it as <stem>.from-<host><ext>
//                         (host sanitised), suffixing -2, -3, ... if taken.
//   - MEMORY.md         -> line UNION: cloud lines first, then local lines not
//                         already present (exact-string match), no duplicates.
// Merge is additive only: it never overwrites or deletes either side's data.

// Sanitise the hostname to [A-Za-z0-9_-] for use in a filename.
export function mergeHostname() {
  let h = os.hostname() || "";
  h = h.split(".")[0]; // short name, drop any domain
  h = h.replace(/[^A-Za-z0-9_-]/g, "-").replace(/-+$/, "");
  return h || "host";
}

function splitStemExt(base) {
  const idx = base.lastIndexOf(".");
  if (idx > 0) {
    return { stem: base.slice(0, idx), ext: base.slice(idx) };
  }
  return { stem: base, ext: "" };
}

// Free keep-both target name: "<stem>.from-<host><ext>", suffixed -2/-3/...
export function mergeKeepBothName(dir, base, host) {
  const { stem, ext } = splitStemExt(base);
  let cand = `${stem}.from-${host}${ext}`;
  if (!fs.existsSync(path.join(dir, cand))) return cand;
  let n = 2;
  while (fs.existsSync(path.join(dir, `${stem}.from-${host}-${n}${ext}`))) n += 1;
  return `${stem}.from-${host}-${n}${ext}`;
}

function readLines(file) {
  const text = fs.readFileSync(file, "utf8");
  // Preserve content faithfully; split on newline. A trailing newline yields a
  // final empty element we drop so we don't append a spurious blank line.
  const parts = text.split("\n");
  if (parts.length && parts[parts.length - 1] === "") parts.pop();
  return { parts, trailingNewline: text.endsWith("\n") };
}

// Build the line union for MEMORY.md: every cloud line in order, then each local
// line not already present (exact-string match). Writes the result to outPath.
export function mergeMemoryUnion(cloudFile, localFile, outPath) {
  const cloudExists = fs.existsSync(cloudFile);
  const localExists = fs.existsSync(localFile);
  if (!cloudExists && !localExists) return;
  if (!cloudExists) {
    fs.copyFileSync(localFile, outPath);
    return;
  }
  if (!localExists) return; // cloud already has it

  const cloud = readLines(cloudFile);
  const local = readLines(localFile);
  const seen = new Set(cloud.parts);
  const merged = [...cloud.parts];
  for (const line of local.parts) {
    if (seen.has(line)) continue;
    seen.add(line);
    merged.push(line);
  }
  let outText = merged.join("\n");
  if (cloud.trailingNewline || local.trailingNewline) outText += "\n";
  fs.writeFileSync(outPath, outText);
}

function filesEqual(a, b) {
  try {
    const ba = fs.readFileSync(a);
    const bb = fs.readFileSync(b);
    return ba.equals(bb);
  } catch {
    return false;
  }
}

// Run (or, in dry mode, plan) the merge of local memory into the cloud target.
// Returns { copied, unioned, keptBoth }.
export function doMerge(localDir, cloudDir, mode = "apply") {
  const host = mergeHostname();
  const result = { copied: 0, unioned: 0, keptBoth: 0 };

  if (!fs.existsSync(localDir) || !fs.statSync(localDir).isDirectory()) {
    throw new Error(`local memory directory not found: ${localDir}`);
  }
  fs.mkdirSync(cloudDir, { recursive: true });

  let entries;
  try {
    entries = fs.readdirSync(localDir, { withFileTypes: true });
  } catch {
    entries = [];
  }
  // Sort for deterministic dry-run output.
  entries.sort((a, b) => a.name.localeCompare(b.name));

  for (const ent of entries) {
    const base = ent.name;
    const lpath = path.join(localDir, base);
    const cpath = path.join(cloudDir, base);
    // Only top-level regular files (flat memory dir).
    let lst;
    try {
      lst = fs.statSync(lpath);
    } catch {
      continue;
    }
    if (!lst.isFile()) continue;

    if (base === "MEMORY.md") {
      if (!fs.existsSync(cpath)) {
        if (mode === "dry") info(`  copy        ${base}  (cloud has no MEMORY.md yet)`);
        else fs.copyFileSync(lpath, cpath);
        result.copied += 1;
        continue;
      }
      if (filesEqual(lpath, cpath)) {
        if (mode === "dry") info(`  identical   ${base}  (no change)`);
        continue;
      }
      if (mode === "dry") info(`  union       ${base}  (merge unique lines into cloud MEMORY.md)`);
      else mergeMemoryUnion(cpath, lpath, cpath);
      result.unioned += 1;
      continue;
    }

    if (!fs.existsSync(cpath)) {
      if (mode === "dry") info(`  copy        ${base}  (local-only -> cloud)`);
      else fs.copyFileSync(lpath, cpath);
      result.copied += 1;
      continue;
    }

    if (filesEqual(lpath, cpath)) {
      if (mode === "dry") info(`  identical   ${base}  (no change)`);
      continue;
    }

    const keep = mergeKeepBothName(cloudDir, base, host);
    if (mode === "dry") info(`  keep-both   ${base}  (cloud kept; local saved as ${keep})`);
    else fs.copyFileSync(lpath, path.join(cloudDir, keep));
    result.keptBoth += 1;
  }

  return result;
}

export function mergeSummary(result) {
  return `Merge summary: ${result.copied} copied, ${result.unioned} unioned, ${result.keptBoth} kept-both.`;
}
