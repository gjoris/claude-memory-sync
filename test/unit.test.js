// In-process unit tests for the pure library functions. No mocks: every test
// uses a real temp directory and real files/symlinks. Output-emitting functions
// (conflicts.js) are exercised with stdout/stderr captured so the run stays quiet
// while we assert on their return values and key messages.
//
// Run with: node test/unit.test.js
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import {
  slugifyCwd,
  memoryPath,
  cloudTarget,
  isLink,
  resolveLinkTarget,
  readLinkRaw,
  countFiles,
  dirHasEntries,
  createDirLink,
  lstatSafe,
  statSafe,
} from "../lib/paths.js";
import { backupDir, timestamp } from "../lib/backup.js";
import {
  PROVIDERS,
  ONEDRIVE_PATH_CAP,
  providerLabel,
  providerRoot,
  ProviderError,
  offlineInstruction,
  isRcloneMount,
} from "../lib/providers.js";
import {
  mergeHostname,
  mergeKeepBothName,
  mergeMemoryUnion,
  doMerge,
  mergeSummary,
} from "../lib/merge.js";
import {
  canonicalForConflict,
  detectConflictCopies,
  detectStaleLock,
} from "../lib/conflicts.js";
import { cmdSetup, cmdDoctor, cmdRestore } from "../lib/commands.js";

let pass = 0;
let fail = 0;
function chk(desc, expected, actual) {
  if (expected === actual) {
    console.log(`PASS  ${desc}`);
    pass++;
  } else {
    console.log(`FAIL  ${desc}\n      expected=[${expected}]\n      actual  =[${actual}]`);
    fail++;
  }
}
function chkTrue(desc, actual) {
  chk(desc, true, !!actual);
}

// Run fn with stdout+stderr captured; return the combined text.
function withCapture(fn) {
  const out = [];
  const so = process.stdout.write.bind(process.stdout);
  const se = process.stderr.write.bind(process.stderr);
  process.stdout.write = (s) => (out.push(s), true);
  process.stderr.write = (s) => (out.push(s), true);
  try {
    fn();
  } finally {
    process.stdout.write = so;
    process.stderr.write = se;
  }
  return out.join("");
}

function mkTmp() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cms-unit-")));
}

const sandboxes = [];
function sandbox() {
  const s = mkTmp();
  sandboxes.push(s);
  return s;
}

// ===========================================================================
// paths.js
// ===========================================================================
console.log("########## paths.js ##########");

chk("slugifyCwd replaces forward slashes", "-Users-geroen", slugifyCwd("/Users/geroen"));
chk("slugifyCwd replaces backslashes", "C:-Users-geroen", slugifyCwd("C:\\Users\\geroen"));

{
  const home = "/home/x";
  const expected = path.join(home, ".claude", "projects", "-tmp-proj", "memory");
  chk("memoryPath composes slug under home", expected, memoryPath("/tmp/proj", home));
  chk("cloudTarget appends _SYSTEM/claude-memory", path.join("/root", "_SYSTEM", "claude-memory"), cloudTarget("/root"));
}

{
  const s = sandbox();
  const target = path.join(s, "target");
  const link = path.join(s, "link");
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, "a.md"), "A\n");
  fs.mkdirSync(path.join(target, "sub"));
  fs.writeFileSync(path.join(target, "sub", "b.md"), "B\n");

  chk("isLink false for a plain dir", false, isLink(target));
  const kind = createDirLink(target, link);
  chk("createDirLink returns symlink on posix", process.platform === "win32" ? "junction" : "symlink", kind);
  chk("isLink true for the created link", true, isLink(link));
  chk("resolveLinkTarget resolves to the real dir", fs.realpathSync(target), resolveLinkTarget(link));
  // Windows junctions report the target with a trailing separator; compare with
  // any trailing separator stripped so the assertion holds on every platform.
  const stripSep = (p) => p.replace(/[\\/]+$/, "");
  chk("readLinkRaw returns the stored target", stripSep(target), stripSep(readLinkRaw(link)));
  chk("countFiles follows the link and recurses", 2, countFiles(link));
  chk("countFiles is 0 for a missing dir", 0, countFiles(path.join(s, "nope")));
  chk("dirHasEntries true when populated", true, dirHasEntries(target));
  fs.mkdirSync(path.join(s, "empty"));
  chk("dirHasEntries false when empty", false, dirHasEntries(path.join(s, "empty")));

  chk("lstatSafe returns null for missing", null, lstatSafe(path.join(s, "nope")));
  chk("statSafe returns null for missing", null, statSafe(path.join(s, "nope")));
  chk("resolveLinkTarget null for a non-link", null, resolveLinkTarget(target));
  chk("readLinkRaw null for a non-link", null, readLinkRaw(target));

  // Broken link: target removed after linking.
  const broken = path.join(s, "broken");
  const gone = path.join(s, "gone");
  fs.mkdirSync(gone);
  createDirLink(gone, broken);
  fs.rmdirSync(gone);
  chk("isLink true even when target is gone", true, isLink(broken));
  chk("resolveLinkTarget null for a broken link", null, resolveLinkTarget(broken));
}

// ===========================================================================
// backup.js
// ===========================================================================
console.log("\n########## backup.js ##########");

chk("timestamp formats YYYYMMDD-HHMMSS", "20260530-090807", timestamp(new Date(2026, 4, 30, 9, 8, 7)));

{
  const s = sandbox();
  const src = path.join(s, "memory");
  fs.mkdirSync(path.join(src, "sub"), { recursive: true });
  fs.writeFileSync(path.join(src, "MEMORY.md"), "index\n");
  fs.writeFileSync(path.join(src, "sub", "deep.md"), "deep content\n");
  fs.mkdirSync(path.join(src, "emptydir"));

  const out = path.join(s, "backup.tar.gz");
  backupDir(src, out);
  chkTrue("backup file written", fs.existsSync(out) && fs.statSync(out).size > 0);

  // Round-trip: extract with the system tar and compare.
  const ex = path.join(s, "extract");
  fs.mkdirSync(ex);
  execFileSync("tar", ["-xzf", out, "-C", ex]);
  chk("round-trip: MEMORY.md content", "index\n", fs.readFileSync(path.join(ex, "memory", "MEMORY.md"), "utf8"));
  chk("round-trip: nested file content", "deep content\n", fs.readFileSync(path.join(ex, "memory", "sub", "deep.md"), "utf8"));
  chkTrue("round-trip: empty dir survives", fs.existsSync(path.join(ex, "memory", "emptydir")));
}

// ===========================================================================
// merge.js
// ===========================================================================
console.log("\n########## merge.js ##########");

chkTrue("mergeHostname is non-empty and sanitised", /^[A-Za-z0-9_-]+$/.test(mergeHostname()));

{
  const s = sandbox();
  chk("keep-both first free name", "conflict.from-host.md", mergeKeepBothName(s, "conflict.md", "host"));
  // collision: the base name is taken, expect -2 (then -3).
  const n2 = mergeKeepBothName(s, "taken.md", "host"); // taken.from-host.md is free -> no suffix
  chk("keep-both no suffix when free", "taken.from-host.md", n2);
  fs.writeFileSync(path.join(s, "taken.from-host.md"), "x");
  chk("keep-both -2 when first taken", "taken.from-host-2.md", mergeKeepBothName(s, "taken.md", "host"));
  fs.writeFileSync(path.join(s, "taken.from-host-2.md"), "x");
  chk("keep-both -3 when -2 taken", "taken.from-host-3.md", mergeKeepBothName(s, "taken.md", "host"));
  // extensionless name
  chk("keep-both handles no extension", "LICENSE.from-host", mergeKeepBothName(s, "LICENSE", "host"));
}

{
  // mergeMemoryUnion: cloud lines first, then unique local lines, no dupes.
  const s = sandbox();
  const cloud = path.join(s, "cloud.md");
  const local = path.join(s, "local.md");
  fs.writeFileSync(cloud, "- shared\n- cloud-only\n");
  fs.writeFileSync(local, "- shared\n- local-only\n");
  mergeMemoryUnion(cloud, local, cloud);
  const merged = fs.readFileSync(cloud, "utf8");
  chk("union keeps shared once", 1, (merged.match(/- shared/g) || []).length);
  chk("union keeps cloud-only", 1, (merged.match(/- cloud-only/g) || []).length);
  chk("union appends local-only", 1, (merged.match(/- local-only/g) || []).length);
  chk("union order: cloud before local", true, merged.indexOf("cloud-only") < merged.indexOf("local-only"));

  // cloud missing -> copy local in
  const c2 = path.join(s, "c2.md");
  const l2 = path.join(s, "l2.md");
  fs.writeFileSync(l2, "only local\n");
  mergeMemoryUnion(c2, l2, c2);
  chk("union with no cloud copies local", "only local\n", fs.readFileSync(c2, "utf8"));
}

{
  // doMerge end-to-end at the function level (apply mode).
  const s = sandbox();
  const local = path.join(s, "local");
  const cloud = path.join(s, "cloud");
  fs.mkdirSync(local);
  fs.mkdirSync(cloud);
  fs.writeFileSync(path.join(local, "only-local.md"), "L\n");
  fs.writeFileSync(path.join(local, "same.md"), "S\n");
  fs.writeFileSync(path.join(cloud, "same.md"), "S\n");
  fs.writeFileSync(path.join(local, "diff.md"), "local diff\n");
  fs.writeFileSync(path.join(cloud, "diff.md"), "cloud diff\n");
  fs.writeFileSync(path.join(local, "MEMORY.md"), "- a\n- b\n");
  fs.writeFileSync(path.join(cloud, "MEMORY.md"), "- a\n- c\n");
  // a non-file entry must be skipped
  fs.mkdirSync(path.join(local, "adir"));

  const host = mergeHostname();
  let res;
  withCapture(() => (res = doMerge(local, cloud, "apply")));
  chk("doMerge copied count", 1, res.copied);
  chk("doMerge unioned count", 1, res.unioned);
  chk("doMerge keptBoth count", 1, res.keptBoth);
  chkTrue("doMerge: local-only landed in cloud", fs.existsSync(path.join(cloud, "only-local.md")));
  chk("doMerge: cloud diff keeps canonical", "cloud diff\n", fs.readFileSync(path.join(cloud, "diff.md"), "utf8"));
  chkTrue("doMerge: local diff kept-both", fs.existsSync(path.join(cloud, `diff.from-${host}.md`)));
  const mem = fs.readFileSync(path.join(cloud, "MEMORY.md"), "utf8");
  chk("doMerge: MEMORY union has b", 1, (mem.match(/- b/g) || []).length);
  chk("doMerge: MEMORY union kept c", 1, (mem.match(/- c/g) || []).length);

  chk("mergeSummary text", "Merge summary: 1 copied, 1 unioned, 1 kept-both.", mergeSummary(res));

  // Dry mode plans the same actions but writes nothing.
  {
    const d = sandbox();
    const dl = path.join(d, "local");
    const dc = path.join(d, "cloud");
    fs.mkdirSync(dl);
    fs.mkdirSync(dc);
    fs.writeFileSync(path.join(dl, "new.md"), "N\n");          // copy
    fs.writeFileSync(path.join(dl, "same.md"), "S\n");          // identical
    fs.writeFileSync(path.join(dc, "same.md"), "S\n");
    fs.writeFileSync(path.join(dl, "diff.md"), "L\n");          // keep-both
    fs.writeFileSync(path.join(dc, "diff.md"), "C\n");
    fs.writeFileSync(path.join(dl, "MEMORY.md"), "- a\n- l\n"); // union
    fs.writeFileSync(path.join(dc, "MEMORY.md"), "- a\n- c\n");
    let dres;
    const dtext = withCapture(() => (dres = doMerge(dl, dc, "dry")));
    chk("dry: plans 1 copy", 1, dres.copied);
    chk("dry: plans 1 union", 1, dres.unioned);
    chk("dry: plans 1 keep-both", 1, dres.keptBoth);
    chkTrue("dry: prints a copy line", dtext.includes("copy"));
    chkTrue("dry: prints an identical line", dtext.includes("identical"));
    chkTrue("dry: prints a union line", dtext.includes("union"));
    chkTrue("dry: prints a keep-both line", dtext.includes("keep-both"));
    chk("dry: wrote nothing new to cloud", false, fs.existsSync(path.join(dc, "new.md")));
  }

  // Dry mode with an IDENTICAL MEMORY.md on both sides -> "identical" plan line.
  {
    const d = sandbox();
    const dl = path.join(d, "local");
    const dc = path.join(d, "cloud");
    fs.mkdirSync(dl);
    fs.mkdirSync(dc);
    fs.writeFileSync(path.join(dl, "MEMORY.md"), "- a\n");
    fs.writeFileSync(path.join(dc, "MEMORY.md"), "- a\n");
    let r3;
    const t3 = withCapture(() => (r3 = doMerge(dl, dc, "dry")));
    chk("dry: identical MEMORY.md is a no-op", 0, r3.copied + r3.unioned + r3.keptBoth);
    chkTrue("dry: identical MEMORY.md prints no-change", t3.includes("identical") && t3.includes("MEMORY.md"));
  }

  // doMerge copies MEMORY.md when cloud has none yet.
  {
    const d = sandbox();
    const dl = path.join(d, "local");
    const dc = path.join(d, "cloud");
    fs.mkdirSync(dl);
    fs.mkdirSync(dc);
    fs.writeFileSync(path.join(dl, "MEMORY.md"), "- fresh\n");
    let r2;
    withCapture(() => (r2 = doMerge(dl, dc, "apply")));
    chk("doMerge copies absent MEMORY.md", 1, r2.copied);
    chkTrue("doMerge: cloud now has MEMORY.md", fs.existsSync(path.join(dc, "MEMORY.md")));
  }

  // doMerge throws when local dir missing.
  let threw = false;
  try {
    doMerge(path.join(s, "nope"), cloud, "apply");
  } catch {
    threw = true;
  }
  chk("doMerge throws on missing local dir", true, threw);
}

// ===========================================================================
// conflicts.js
// ===========================================================================
console.log("\n########## conflicts.js ##########");

chk("canonical: Google '(1)'", "MEMORY.md", canonicalForConflict("MEMORY (1).md"));
chk("canonical: Dropbox conflicted copy", "notes.md", canonicalForConflict("notes (Mac's conflicted copy 2026-05-30).md"));
chk("canonical: OneDrive '(conflicted)'", "notes.md", canonicalForConflict("notes (conflicted).md"));
chk("canonical: iCloud ' 2'", "MEMORY.md", canonicalForConflict("MEMORY 2.md"));
chk("canonical: machine suffix", "MEMORY.md", canonicalForConflict("MEMORY-DESKTOP.md"));
chk("canonical: plain name -> null", null, canonicalForConflict("plain.md"));
chk("canonical: extensionless '(1)'", "LICENSE", canonicalForConflict("LICENSE (1)"));
chk("canonical: Dropbox without parens", "notes.md", canonicalForConflict("notes conflicted copy.md"));
chk("canonical: empty stem -> null", null, canonicalForConflict(" (1).md"));

{
  // Differing conflict copy with a present canonical -> 1 unresolved.
  const s = sandbox();
  fs.writeFileSync(path.join(s, "notes.md"), "canonical\n");
  fs.writeFileSync(path.join(s, "notes (1).md"), "different\n");
  let n;
  const text = withCapture(() => (n = detectConflictCopies(s)));
  chk("detect: differing copy is unresolved", 1, n);
  chkTrue("detect: reports the conflict copy name", text.includes("notes (1).md"));
}
{
  // Identical conflict copy -> found but 0 unresolved.
  const s = sandbox();
  fs.writeFileSync(path.join(s, "notes.md"), "same\n");
  fs.writeFileSync(path.join(s, "notes (1).md"), "same\n");
  let n;
  const text = withCapture(() => (n = detectConflictCopies(s)));
  chk("detect: identical copy is resolved (0)", 0, n);
  chkTrue("detect: flags it as a safe duplicate", text.includes("IDENTICAL") || text.includes("safe duplicate"));
}
{
  // No conflicts at all -> 0 and an "ok" line.
  const s = sandbox();
  fs.writeFileSync(path.join(s, "MEMORY.md"), "x\n");
  let n;
  const text = withCapture(() => (n = detectConflictCopies(s)));
  chk("detect: clean dir is 0", 0, n);
  chkTrue("detect: prints the ok line", text.includes("no cloud-sync conflict copies"));
}
{
  // Explicit-marker conflict copy whose canonical is MISSING -> found, but the
  // copy may be the only survivor (0 unresolved, with a "rename back" hint).
  const s = sandbox();
  fs.writeFileSync(path.join(s, "notes (conflicted).md"), "survivor\n");
  let n;
  const text = withCapture(() => (n = detectConflictCopies(s)));
  chk("detect: orphan conflict copy is 0 unresolved", 0, n);
  chkTrue("detect: warns canonical is missing", text.includes("missing"));
  chkTrue("detect: suggests renaming it back", text.includes("mv --"));
}
{
  // LOCK file is never treated as a conflict copy.
  const s = sandbox();
  fs.writeFileSync(path.join(s, "LOCK"), "host=x\n");
  let n;
  withCapture(() => (n = detectConflictCopies(s)));
  chk("detect: LOCK ignored", 0, n);
}
{
  // detectStaleLock surfaces an existing LOCK and never throws.
  const s = sandbox();
  fs.writeFileSync(path.join(s, "LOCK"), "host=laptop\nacquired=2026-05-30T10:00:00Z\n");
  const text = withCapture(() => detectStaleLock(s));
  chkTrue("stale lock: reports the host", text.includes("laptop"));
  chkTrue("stale lock: reports it is advisory", text.toLowerCase().includes("advisory"));
  // No LOCK -> silent, no throw.
  const s2 = sandbox();
  const text2 = withCapture(() => detectStaleLock(s2));
  chk("stale lock: silent when absent", "", text2);
}

// ===========================================================================
// providers.js
// ===========================================================================
// We never stub fs/child_process (that would be fragile). Instead we override
// two stable inputs the module reads: $HOME (via os.homedir on POSIX) and
// process.platform. With a sandbox HOME full of real fake provider dirs, the
// detection runs against the real filesystem; flipping process.platform lets us
// exercise the Windows/Linux branches that can't otherwise run on darwin.
console.log("\n########## providers.js ##########");

// Run fn with process.platform forced to `plat` and HOME/USERPROFILE pointed at
// `h`. Restores everything afterwards, even on throw.
function withEnv(plat, h, fn) {
  const origPlat = Object.getOwnPropertyDescriptor(process, "platform");
  const origHome = process.env.HOME;
  const origUP = process.env.USERPROFILE;
  Object.defineProperty(process, "platform", { value: plat, configurable: true });
  process.env.HOME = h;
  process.env.USERPROFILE = h;
  try {
    return fn();
  } finally {
    Object.defineProperty(process, "platform", origPlat);
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    if (origUP === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = origUP;
  }
}

// Put a fake executable named `name` (a shell script printing `output`) on PATH,
// run fn, then restore PATH. Real execFileSync finds and runs it — no mock.
function withFakeExe(name, output, fn) {
  const dir = sandbox();
  const exe = path.join(dir, name);
  fs.writeFileSync(exe, `#!/bin/sh\ncat <<'EOF'\n${output}\nEOF\n`);
  fs.chmodSync(exe, 0o755);
  const origPath = process.env.PATH;
  process.env.PATH = `${dir}:${origPath}`;
  try {
    return fn();
  } finally {
    process.env.PATH = origPath;
  }
}

chk("PROVIDERS lists the four", "google,dropbox,onedrive,icloud", PROVIDERS.join(","));
chk("ONEDRIVE_PATH_CAP is 400", 400, ONEDRIVE_PATH_CAP);

chk("label google", "Google Drive", providerLabel("google"));
chk("label dropbox", "Dropbox", providerLabel("dropbox"));
chk("label onedrive", "OneDrive", providerLabel("onedrive"));
chk("label icloud", "iCloud Drive", providerLabel("icloud"));
chk("label unknown passes through", "weird", providerLabel("weird"));

chkTrue("offline google mentions Mirror", offlineInstruction("google").includes("Mirror"));
chkTrue("offline onedrive mentions Always keep", offlineInstruction("onedrive").includes("Always keep"));
chkTrue("offline icloud mentions Keep Downloaded", offlineInstruction("icloud").includes("Keep Downloaded"));
chkTrue("offline dropbox mentions available offline", offlineInstruction("dropbox").includes("available offline"));
chkTrue("offline unknown has a fallback", offlineInstruction("nope").includes("available offline"));

chk("providerRoot unknown -> null root", null, providerRoot("mystery").root);
chk("isRcloneMount false off-linux", false, isRcloneMount("/anything"));

// --- rclone / PSDrive subprocess paths (fake exe on PATH, real parsing) -----
// These drop a `#!/bin/sh` fake executable on PATH and rely on POSIX exec, so
// they only run off Windows. The branches they cover (rclone is Linux-only;
// the PSDrive parser) are exercised through their real OS elsewhere.
if (process.platform === "win32") {
  console.log("SKIP  rclone/PSDrive fake-exe tests (need POSIX shell exec)");
} else {
  {
    // isRcloneMount: a fake `mount` reports an rclone FUSE mount covering /mnt/gd.
    const mountOut = "rclone:gdrive on /mnt/gd type fuse.rclone (rw,nosuid,nodev)";
    withEnv("linux", sandbox(), () => {
      withFakeExe("mount", mountOut, () => {
        chk("isRcloneMount true for a covered path", true, isRcloneMount("/mnt/gd"));
        chk("isRcloneMount true for a subpath", true, isRcloneMount("/mnt/gd/sub"));
        chk("isRcloneMount false for an unrelated path", false, isRcloneMount("/mnt/other"));
      });
    });
  }
  {
    // Linux google detection on an rclone-backed folder gets the rclone caveat.
    const h = sandbox();
    fs.mkdirSync(path.join(h, "gdrive"), { recursive: true });
    const mountOut = `rclone:gd on ${path.join(h, "gdrive")} type fuse.rclone (rw)`;
    withEnv("linux", h, () => {
      withFakeExe("mount", mountOut, () => {
        const g = providerRoot("google");
        chk("linux google on rclone mount", path.join(h, "gdrive"), g.root);
        chkTrue("linux google rclone caveat", g.warning.includes("rclone"));
      });
    });
  }
  {
    // googleRootWindows PSDrive branch: a fake `powershell` lists a drive root
    // that contains a "My Drive" folder.
    const h = sandbox();
    const gdrive = path.join(h, "FakeDrive");
    fs.mkdirSync(path.join(gdrive, "My Drive"), { recursive: true });
    withEnv("win32", h, () => {
      withFakeExe("powershell", gdrive, () => {
        chk("win google via PSDrive root", path.join(gdrive, "My Drive"), providerRoot("google").root);
      });
    });
  }
}

// --- macOS detection against real fake dirs --------------------------------
{
  const h = sandbox();
  const cs = path.join(h, "Library", "CloudStorage");
  fs.mkdirSync(path.join(cs, "GoogleDrive-me@x.com", "My Drive"), { recursive: true });
  fs.mkdirSync(path.join(cs, "OneDrive-Personal"), { recursive: true });
  fs.mkdirSync(path.join(h, "Dropbox"), { recursive: true });
  fs.mkdirSync(path.join(h, "Library", "Mobile Documents", "com~apple~CloudDocs"), { recursive: true });

  withEnv("darwin", h, () => {
    chk("mac google finds My Drive", path.join(cs, "GoogleDrive-me@x.com", "My Drive"), providerRoot("google").root);
    chk("mac dropbox finds ~/Dropbox", path.join(h, "Dropbox"), providerRoot("dropbox").root);
    chk("mac onedrive finds Personal", path.join(cs, "OneDrive-Personal"), providerRoot("onedrive").root);
    chk("mac icloud finds CloudDocs", path.join(h, "Library", "Mobile Documents", "com~apple~CloudDocs"), providerRoot("icloud").root);
  });
}

// macOS --account selection + fallbacks.
{
  const h = sandbox();
  const cs = path.join(h, "Library", "CloudStorage");
  // Two Google mounts; an explicit account picks the right one.
  fs.mkdirSync(path.join(cs, "GoogleDrive-work@x.com", "My Drive"), { recursive: true });
  fs.mkdirSync(path.join(cs, "GoogleDrive-home@x.com", "My Drive"), { recursive: true });
  // A OneDrive org mount whose account we name explicitly.
  fs.mkdirSync(path.join(cs, "OneDrive-Contoso"), { recursive: true });
  withEnv("darwin", h, () => {
    chk("mac google honours --account", path.join(cs, "GoogleDrive-work@x.com", "My Drive"),
      providerRoot("google", "work@x.com").root);
    chk("mac onedrive honours --account", path.join(cs, "OneDrive-Contoso"),
      providerRoot("onedrive", "Contoso").root);
  });
}
{
  // Google mac last-resort: a mount with no localized "My Drive", just a subdir.
  const h = sandbox();
  const cs = path.join(h, "Library", "CloudStorage");
  fs.mkdirSync(path.join(cs, "GoogleDrive-acc", "Shared drives"), { recursive: true });
  withEnv("darwin", h, () => {
    chk("mac google last-resort first subdir", path.join(cs, "GoogleDrive-acc", "Shared drives"),
      providerRoot("google").root);
  });
}
{
  // OneDrive mac: no Personal, but a first OneDrive-<Org> mount is picked.
  const h = sandbox();
  const cs = path.join(h, "Library", "CloudStorage");
  fs.mkdirSync(path.join(cs, "OneDrive-Acme"), { recursive: true });
  withEnv("darwin", h, () => {
    chk("mac onedrive picks first org mount", path.join(cs, "OneDrive-Acme"),
      providerRoot("onedrive").root);
  });
}

// Empty mac HOME -> nothing detected (null roots, no throw for mac providers).
{
  const h = sandbox();
  withEnv("darwin", h, () => {
    chk("mac google null when absent", null, providerRoot("google").root);
    chk("mac dropbox null when absent", null, providerRoot("dropbox").root);
    chk("mac onedrive null when absent", null, providerRoot("onedrive").root);
    chk("mac icloud null when absent", null, providerRoot("icloud").root);
  });
}

// --- Linux branches: ProviderError vs. third-party warning -----------------
{
  const h = sandbox();
  withEnv("linux", h, () => {
    let threw = false;
    try { providerRoot("google"); } catch (e) { threw = e instanceof ProviderError; }
    chk("linux google throws ProviderError when no mount", true, threw);

    let threw2 = false;
    try { providerRoot("onedrive"); } catch (e) { threw2 = e instanceof ProviderError; }
    chk("linux onedrive throws ProviderError when no mount", true, threw2);

    let threw3 = false;
    try { providerRoot("icloud"); } catch (e) { threw3 = e instanceof ProviderError; }
    chk("linux icloud always throws (no client)", true, threw3);
  });
}
{
  // Linux with a real third-party folder -> root + non-fatal warning.
  const h = sandbox();
  fs.mkdirSync(path.join(h, "google-drive"), { recursive: true });
  fs.mkdirSync(path.join(h, "OneDrive"), { recursive: true });
  withEnv("linux", h, () => {
    const g = providerRoot("google");
    chk("linux google detects ~/google-drive", path.join(h, "google-drive"), g.root);
    chkTrue("linux google carries a caveat", !!g.warning);
    const o = providerRoot("onedrive");
    chk("linux onedrive detects ~/OneDrive", path.join(h, "OneDrive"), o.root);
    chkTrue("linux onedrive carries a caveat", !!o.warning);
  });
}
{
  // Linux Insync per-account folder gets the Insync-specific warning.
  const h = sandbox();
  fs.mkdirSync(path.join(h, "Insync", "me@x.com"), { recursive: true });
  withEnv("linux", h, () => {
    const g = providerRoot("google");
    chk("linux google picks Insync account dir", path.join(h, "Insync", "me@x.com"), g.root);
    chkTrue("linux Insync warning mentions Insync", g.warning.includes("Insync"));
  });
}

// --- Windows branches -------------------------------------------------------
{
  const h = sandbox();
  fs.mkdirSync(path.join(h, "Dropbox"), { recursive: true });
  fs.mkdirSync(path.join(h, "OneDrive"), { recursive: true });
  fs.mkdirSync(path.join(h, "iCloudDrive"), { recursive: true });
  fs.mkdirSync(path.join(h, "Google Drive", "My Drive"), { recursive: true });
  withEnv("win32", h, () => {
    chk("win dropbox finds %USERPROFILE%\\Dropbox", path.join(h, "Dropbox"), providerRoot("dropbox").root);
    chk("win onedrive finds %USERPROFILE%\\OneDrive", path.join(h, "OneDrive"), providerRoot("onedrive").root);
    chk("win icloud finds iCloudDrive", path.join(h, "iCloudDrive"), providerRoot("icloud").root);
    chk("win google finds Google Drive\\My Drive", path.join(h, "Google Drive", "My Drive"), providerRoot("google").root);
  });
}
{
  // Windows --account: "OneDrive - <Org>" and a Dropbox "(account)" folder.
  const h = sandbox();
  fs.mkdirSync(path.join(h, "OneDrive - Contoso"), { recursive: true });
  fs.mkdirSync(path.join(h, "Dropbox (Work)"), { recursive: true });
  withEnv("win32", h, () => {
    chk("win onedrive --account", path.join(h, "OneDrive - Contoso"), providerRoot("onedrive", "Contoso").root);
    chk("win dropbox --account", path.join(h, "Dropbox (Work)"), providerRoot("dropbox", "Work").root);
  });
}
{
  // Windows OneDrive first-org-mount fallback (no plain OneDrive, no account).
  const h = sandbox();
  fs.mkdirSync(path.join(h, "OneDrive - Globex"), { recursive: true });
  withEnv("win32", h, () => {
    chk("win onedrive first-org fallback", path.join(h, "OneDrive - Globex"), providerRoot("onedrive").root);
  });
}
{
  // Linux OneDrive --account folder.
  const h = sandbox();
  fs.mkdirSync(path.join(h, "OneDrive-work"), { recursive: true });
  withEnv("linux", h, () => {
    const o = providerRoot("onedrive", "work");
    chk("linux onedrive --account", path.join(h, "OneDrive-work"), o.root);
    chkTrue("linux onedrive --account carries caveat", !!o.warning);
  });
}
{
  // Linux Dropbox is the one official client — detect ~/Dropbox, no warning.
  const h = sandbox();
  fs.mkdirSync(path.join(h, "Dropbox"), { recursive: true });
  withEnv("linux", h, () => {
    chk("linux dropbox detects ~/Dropbox", path.join(h, "Dropbox"), providerRoot("dropbox").root);
  });
}

// ===========================================================================
// commands.js — platform-dependent branches (in-process)
// ===========================================================================
// A few command branches only run on a specific OS (OneDrive's Windows path-cap
// warning; a provider's Linux third-party caveat / ProviderError). A subprocess
// can't have process.platform overridden from outside, so we drive the command
// functions in-process here: override platform + HOME + cwd (all stable inputs),
// capture output, and turn die()'s process.exit into a throw so we can assert on
// the exit instead of killing the test runner. No fs/child_process mocking.
console.log("\n########## commands.js (platform branches) ##########");

class ExitError extends Error {
  constructor(code) {
    super(`exit ${code}`);
    this.code = code;
  }
}

// Run fn with platform, HOME and cwd forced, output captured, and process.exit
// intercepted. Returns { text, exit } where exit is the code die() asked for (or
// null if it never exited).
function runCmd(plat, h, cwdDir, fn) {
  const origPlat = Object.getOwnPropertyDescriptor(process, "platform");
  const origHome = process.env.HOME;
  const origUP = process.env.USERPROFILE;
  const origExit = process.exit;
  const origCwd = process.cwd;
  Object.defineProperty(process, "platform", { value: plat, configurable: true });
  process.env.HOME = h;
  process.env.USERPROFILE = h;
  process.cwd = () => cwdDir;
  process.exit = (code) => {
    throw new ExitError(code ?? 0);
  };
  let exit = null;
  const text = withCapture(() => {
    try {
      fn();
    } catch (e) {
      if (e instanceof ExitError) exit = e.code;
      else throw e;
    }
  });
  Object.defineProperty(process, "platform", origPlat);
  process.exit = origExit;
  process.cwd = origCwd;
  if (origHome === undefined) delete process.env.HOME;
  else process.env.HOME = origHome;
  if (origUP === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = origUP;
  return { text, exit };
}

// These force a foreign process.platform while building a memory path from the
// real cwd. On Windows the cwd is "C:\..." so the slug embeds a colon mid-path,
// which is an illegal directory name and crashes mkdir. The simulated-OS
// branches are inherently POSIX-only; the real Windows behaviour is covered by
// the CLI lifecycle test that runs on the actual platform.
if (process.platform === "win32") {
  console.log("SKIP  simulated-OS command branches (need POSIX path slugs)");
} else {
{
  // Linux + a real third-party Google folder -> setup prints the caveat banner
  // (commands.js HEADS UP / provider caveat branch) before doing the work.
  const h = sandbox();
  const cwd = sandbox();
  fs.mkdirSync(path.join(h, "google-drive"), { recursive: true });
  // Seed local memory so setup has something to relocate.
  const slug = cwd.replace(/[\\/]/g, "-");
  const mem = path.join(h, ".claude", "projects", slug, "memory");
  fs.mkdirSync(mem, { recursive: true });
  fs.writeFileSync(path.join(mem, "MEMORY.md"), "- x\n");
  const r = runCmd("linux", h, cwd, () => cmdSetup({ provider: "google", account: "" }));
  chkTrue("linux setup prints provider caveat", r.text.includes("provider caveat") || r.text.includes("HEADS UP"));
  chkTrue("linux setup still links", r.text.includes("Linked:"));
}
{
  // Linux + iCloud -> providerRoot throws ProviderError -> resolveTarget die()s
  // with the explained message and a non-zero exit.
  const h = sandbox();
  const cwd = sandbox();
  const r = runCmd("linux", h, cwd, () => cmdSetup({ provider: "icloud", account: "" }));
  chk("linux icloud setup exits 1", 1, r.exit);
  chkTrue("linux icloud setup explains no client", r.text.includes("no Linux client"));
}
{
  // Linux doctor on a link whose target is an rclone mount -> the rclone caveat
  // branch fires. Fake `mount` makes isRcloneMount(target) true.
  const h = sandbox();
  const cwd = sandbox();
  const cloud = path.join(h, "gdrive", "_SYSTEM", "claude-memory");
  fs.mkdirSync(cloud, { recursive: true });
  fs.writeFileSync(path.join(cloud, "MEMORY.md"), "- x\n");
  const slug = cwd.replace(/[\\/]/g, "-");
  const mem = path.join(h, ".claude", "projects", slug, "memory");
  fs.mkdirSync(path.dirname(mem), { recursive: true });
  fs.symlinkSync(cloud, mem, "dir");
  const realCloud = fs.realpathSync(cloud);
  const mountOut = `rclone:gd on ${realCloud} type fuse.rclone (rw)`;
  const r = withFakeExe("mount", mountOut, () =>
    runCmd("linux", h, cwd, () => cmdDoctor({})));
  chkTrue("linux doctor warns about rclone mount", r.text.includes("rclone mount"));
}
{
  // Windows + OneDrive with a HOME deep enough that the cloud target path
  // (HOME/OneDrive/_SYSTEM/claude-memory) exceeds the 400-char cap -> warning.
  // The cap check is on the cloud target length, which derives from HOME, so we
  // build HOME from nested segments (each < 255 chars) to clear 400 total.
  const seg = "d".repeat(90);
  const h = path.join(sandbox(), seg, seg, seg, seg);
  fs.mkdirSync(path.join(h, "OneDrive"), { recursive: true });
  const cwd = sandbox();
  const r = runCmd("win32", h, cwd, () => cmdSetup({ provider: "onedrive", account: "" }));
  chkTrue("win onedrive long path warns over cap", r.text.includes("over OneDrive's"));
}
}

// ===========================================================================
// commands.js — real fault-injection for the die() catch paths
// ===========================================================================
// These exercise the "operation failed -> die()" branches WITHOUT mocking fs:
// we make a real directory read-only (chmod 0500) so the genuine write/rename/
// link call fails with EACCES, and assert on the explained message + exit code.
// Skipped if the FS doesn't enforce perms (e.g. running as root).
console.log("\n########## commands.js (fault injection) ##########");

function permsEnforced(dir) {
  const probe = path.join(dir, ".probe");
  fs.mkdirSync(dir, { recursive: true });
  const mode = fs.statSync(dir).mode;
  fs.chmodSync(dir, 0o500);
  let blocked = false;
  try {
    fs.writeFileSync(probe, "x");
    fs.rmSync(probe, { force: true });
  } catch {
    blocked = true;
  }
  fs.chmodSync(dir, mode);
  return blocked;
}

const PERMS = permsEnforced(sandbox());
if (!PERMS) {
  console.log("SKIP  filesystem does not enforce 0500 (running as root?) — skipping fault-injection");
} else {
  // (130) setup: backing up existing memory fails because its parent dir is
  // read-only, so the .tar.gz can't be written -> die before any change.
  {
    const h = sandbox();
    const cwd = sandbox();
    fs.mkdirSync(path.join(h, "Dropbox"), { recursive: true });
    const slug = cwd.replace(/[\\/]/g, "-");
    const projDir = path.join(h, ".claude", "projects", slug);
    const mem = path.join(projDir, "memory");
    fs.mkdirSync(mem, { recursive: true });
    fs.writeFileSync(path.join(mem, "MEMORY.md"), "- x\n");
    fs.chmodSync(projDir, 0o500);
    const r = runCmd(process.platform, h, cwd, () => cmdSetup({ provider: "dropbox", account: "" }));
    fs.chmodSync(projDir, 0o700);
    chk("setup backup failure exits 1", 1, r.exit);
    chkTrue("setup backup failure is explained", r.text.includes("backup failed"));
  }

  // (183) setup fresh link: no existing memory, but the projects/<slug> dir is
  // read-only so the symlink can't be created -> die.
  {
    const h = sandbox();
    const cwd = sandbox();
    fs.mkdirSync(path.join(h, "Dropbox"), { recursive: true });
    const slug = cwd.replace(/[\\/]/g, "-");
    const projDir = path.join(h, ".claude", "projects", slug);
    fs.mkdirSync(projDir, { recursive: true }); // exists but will be read-only
    fs.chmodSync(projDir, 0o500);
    const r = runCmd(process.platform, h, cwd, () => cmdSetup({ provider: "dropbox", account: "" }));
    fs.chmodSync(projDir, 0o700);
    chk("setup fresh-link failure exits 1", 1, r.exit);
    chkTrue("setup fresh-link failure is explained", r.text.includes("link creation failed"));
  }

  // (382) restore: a healthy link, but its parent dir is read-only so the link
  // can't be removed -> die.
  {
    const h = sandbox();
    const cwd = sandbox();
    const cloud = path.join(h, "Dropbox", "_SYSTEM", "claude-memory");
    fs.mkdirSync(cloud, { recursive: true });
    fs.writeFileSync(path.join(cloud, "MEMORY.md"), "- x\n");
    const slug = cwd.replace(/[\\/]/g, "-");
    const projDir = path.join(h, ".claude", "projects", slug);
    const mem = path.join(projDir, "memory");
    fs.mkdirSync(projDir, { recursive: true });
    fs.symlinkSync(cloud, mem, "dir");
    fs.chmodSync(projDir, 0o500);
    const r = runCmd(process.platform, h, cwd, () => cmdRestore());
    fs.chmodSync(projDir, 0o700);
    chk("restore remove-link failure exits 1", 1, r.exit);
    chkTrue("restore remove-link failure is explained", r.text.includes("could not remove the link"));
  }
}

// --- null-return / fallthrough branches ------------------------------------
{
  // An unknown OS family ("other"): dropbox still falls back to ~/Dropbox,
  // exercising osFamily()'s default branch.
  const h = sandbox();
  fs.mkdirSync(path.join(h, "Dropbox"), { recursive: true });
  withEnv("freebsd", h, () => {
    chk("other-OS dropbox falls back to ~/Dropbox", path.join(h, "Dropbox"), providerRoot("dropbox").root);
  });
}
{
  // macOS Google: a mount that exists but holds neither a localized "My Drive"
  // nor any subdirectory -> the last-resort loop finds nothing -> null.
  const h = sandbox();
  fs.mkdirSync(path.join(h, "Library", "CloudStorage", "GoogleDrive-empty"), { recursive: true });
  withEnv("darwin", h, () => {
    chk("mac google null when mount is empty", null, providerRoot("google").root);
  });
}
{
  // Windows Google with an empty profile: powershell is absent here so the
  // PSDrive call throws and we fall back to drive letters / %USERPROFILE%\Google
  // Drive, none of which exist -> null.
  const h = sandbox();
  withEnv("win32", h, () => {
    chk("win google null when nothing present", null, providerRoot("google").root);
  });
}
{
  // Windows OneDrive with an empty profile -> no candidates, no org folder -> null.
  const h = sandbox();
  withEnv("win32", h, () => {
    chk("win onedrive null when nothing present", null, providerRoot("onedrive").root);
  });
}
{
  // Linux Google via an explicit --account Insync subfolder.
  const h = sandbox();
  fs.mkdirSync(path.join(h, "Insync", "acct@x.com"), { recursive: true });
  withEnv("linux", h, () => {
    const g = providerRoot("google", "acct@x.com");
    chk("linux google --account Insync dir", path.join(h, "Insync", "acct@x.com"), g.root);
    chkTrue("linux google --account Insync warning", g.warning.includes("Insync"));
  });
}

// Cleanup.
for (const s of sandboxes) fs.rmSync(s, { recursive: true, force: true });

console.log("\n==================================================");
console.log(`RESULT: ${pass} passed, ${fail} failed`);
console.log("==================================================");
process.exit(fail === 0 ? 0 : 1);
