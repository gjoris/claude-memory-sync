// End-to-end CLI lifecycle tests for the command layer (commands.js) and the
// advisory lock (lock.js). No mocks: each run launches the real bin in a child
// process with HOME pointed at a throwaway sandbox, so memoryPath() resolves
// INSIDE the sandbox and the real ~/.claude is never touched. A real fake
// Dropbox folder under that HOME is the provider target, so detection runs
// against the actual filesystem.
//
// Run with: node test/cli.test.js
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(__dirname, "..", "bin", "claude-memory-sync.js");

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

const sandboxes = [];
function sandbox() {
  const s = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cms-cli-")));
  sandboxes.push(s);
  return s;
}

// Run the bin with a fixed cwd and HOME=home. NO_COLOR keeps output plain.
// Extra env (e.g. HOSTNAME, CLAUDE_MEMORY_LOCK_TTL_HOURS) can be merged in.
function run(args, { home, cwd, env = {} }) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    env: { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: "1", ...env },
    encoding: "utf8",
  });
  return { code: r.status, out: r.stdout || "", err: r.stderr || "", all: (r.stdout || "") + (r.stderr || "") };
}

// memoryPath() = HOME/.claude/projects/<slug(cwd)>/memory.
function memDir(home, cwd) {
  const slug = cwd.replace(/[\\/]/g, "-");
  return path.join(home, ".claude", "projects", slug, "memory");
}

console.log("########## CLI: help & errors ##########");
{
  const home = sandbox();
  const cwd = sandbox();
  const help = run(["--help"], { home, cwd });
  chk("--help exits 0", 0, help.code);
  chkTrue("--help shows USAGE", help.out.includes("USAGE"));

  const none = run([], { home, cwd });
  chkTrue("no args shows usage", none.out.includes("USAGE"));

  chkTrue("-h shows usage", run(["-h"], { home, cwd }).out.includes("USAGE"));
  chkTrue("help shows usage", run(["help"], { home, cwd }).out.includes("USAGE"));

  // --flag=value syntax must parse the same as --flag value.
  const eqForm = run(["setup", "--provider=skydrive"], { home, cwd });
  chk("--flag=value parses (bad provider exits 1)", 1, eqForm.code);
  chkTrue("--flag=value passed the value through", eqForm.all.includes("skydrive"));

  const bad = run(["frobnicate"], { home, cwd });
  chk("unknown command exits 1", 1, bad.code);
  chkTrue("unknown command names it", bad.all.includes("frobnicate"));

  const noProv = run(["setup"], { home, cwd });
  chk("setup without provider exits 1", 1, noProv.code);
  chkTrue("setup without provider explains", noProv.all.includes("--provider"));

  const badProv = run(["setup", "--provider", "skydrive"], { home, cwd });
  chk("setup bad provider exits 1", 1, badProv.code);
  chkTrue("setup bad provider names valid ones", badProv.all.includes("google"));
}

console.log("\n########## CLI: status states ##########");
{
  const home = sandbox();
  const cwd = sandbox();

  // Missing.
  let st = run(["status"], { home, cwd });
  chk("status missing exits 0", 0, st.code);
  chkTrue("status missing says missing", st.all.includes("missing"));

  // Real directory (not yet synced).
  const mem = memDir(home, cwd);
  fs.mkdirSync(mem, { recursive: true });
  fs.writeFileSync(path.join(mem, "MEMORY.md"), "- x\n");
  st = run(["status"], { home, cwd });
  chkTrue("status real dir flagged not synced", st.all.includes("real directory"));
  chkTrue("status shows a file count", st.all.includes("File count:  1"));
}
{
  // memory path exists but is a plain FILE (neither link nor directory).
  const home = sandbox();
  const cwd = sandbox();
  const mem = memDir(home, cwd);
  fs.mkdirSync(path.dirname(mem), { recursive: true });
  fs.writeFileSync(mem, "i am a file, not a dir\n");
  const st = run(["status"], { home, cwd });
  chkTrue("status flags neither-link-nor-dir", st.all.includes("neither a link nor a directory"));
  // doctor on the same odd state -> FAIL (no memory dir found).
  const doc = run(["doctor"], { home, cwd });
  chk("doctor odd state exits 1", 1, doc.code);
}

console.log("\n########## CLI: setup -> status -> doctor -> lock -> restore ##########");
{
  const home = sandbox();
  const cwd = sandbox();
  const mem = memDir(home, cwd);

  // Seed local memory with a couple of files.
  fs.mkdirSync(mem, { recursive: true });
  fs.writeFileSync(path.join(mem, "MEMORY.md"), "- a\n- b\n");
  fs.writeFileSync(path.join(mem, "note.md"), "hello\n");

  // A real fake Dropbox folder under HOME so detection succeeds on macOS/Linux.
  // (On macOS dropboxRoot checks ~/Dropbox; this is a real dir, not a mock.)
  fs.mkdirSync(path.join(home, "Dropbox"), { recursive: true });

  const setup = run(["setup", "--provider", "dropbox"], { home, cwd });
  chk("setup exits 0", 0, setup.code);
  chkTrue("setup reports linked", setup.all.includes("Linked:"));
  chkTrue("setup verified copy", setup.all.includes("Verified") || setup.all.includes("Merge summary"));

  // The link now exists and resolves into the Dropbox cloud target.
  const lst = fs.lstatSync(mem);
  chkTrue("memory is now a symlink", lst.isSymbolicLink());
  const cloud = path.join(home, "Dropbox", "_SYSTEM", "claude-memory");
  chkTrue("cloud target populated", fs.existsSync(path.join(cloud, "MEMORY.md")));
  chkTrue("original kept as .old", fs.existsSync(`${mem}.old`));

  // Idempotency: a second setup is a no-op.
  const setup2 = run(["setup", "--provider", "dropbox"], { home, cwd });
  chk("re-setup exits 0", 0, setup2.code);
  chkTrue("re-setup is idempotent", setup2.all.includes("Already set up"));

  // status now reports a link.
  const st = run(["status"], { home, cwd });
  chkTrue("status shows symlink state", st.all.includes("symlink"));
  chkTrue("status shows reachable target", st.all.includes("reachable"));

  // doctor on a healthy link passes.
  const doc = run(["doctor"], { home, cwd });
  chk("doctor healthy exits 0", 0, doc.code);
  chkTrue("doctor all checks passed", doc.all.includes("all checks passed"));

  // lock acquire writes a LOCK into the cloud target; release removes it.
  run(["lock", "acquire"], { home, cwd });
  chkTrue("lock acquire writes LOCK", fs.existsSync(path.join(cloud, "LOCK")));
  run(["lock", "release"], { home, cwd });
  chk("lock release removes LOCK", false, fs.existsSync(path.join(cloud, "LOCK")));

  // lock with a bad action is a no-op usage line, never throws.
  const badLock = run(["lock", "wibble"], { home, cwd });
  chk("lock bad action exits 0", 0, badLock.code);
  chkTrue("lock bad action prints usage", badLock.all.includes("acquire|release"));

  // doctor flags a conflict copy that differs from its canonical.
  fs.writeFileSync(path.join(cloud, "note.md"), "hello\n");
  fs.writeFileSync(path.join(cloud, "note (1).md"), "DIFFERENT\n");
  const docConf = run(["doctor"], { home, cwd });
  chk("doctor with conflict exits 1", 1, docConf.code);
  chkTrue("doctor names the conflict copy", docConf.all.includes("note (1).md"));
  fs.rmSync(path.join(cloud, "note (1).md"));

  // restore reverses setup: link gone, real dir back, cloud copy left in place.
  const res = run(["restore"], { home, cwd });
  chk("restore exits 0", 0, res.code);
  chkTrue("restore reports a real directory again", res.all.includes("real directory again"));
  chk("link replaced by real dir", false, fs.lstatSync(mem).isSymbolicLink());
  chkTrue("restored dir keeps MEMORY.md", fs.existsSync(path.join(mem, "MEMORY.md")));
  chkTrue("cloud copy left in place", fs.existsSync(path.join(cloud, "MEMORY.md")));
}

console.log("\n########## CLI: lock advisory behaviour ##########");
{
  const home = sandbox();
  const cwd = sandbox();
  const mem = memDir(home, cwd);
  fs.mkdirSync(mem, { recursive: true });
  fs.writeFileSync(path.join(mem, "MEMORY.md"), "- x\n");
  fs.mkdirSync(path.join(home, "Dropbox"), { recursive: true });
  run(["setup", "--provider", "dropbox"], { home, cwd });
  const cloud = path.join(home, "Dropbox", "_SYSTEM", "claude-memory");
  const lock = path.join(cloud, "LOCK");

  // A FRESH lock held by ANOTHER host -> warn, and do NOT overwrite it.
  fs.writeFileSync(lock, "host=otherbox\nacquired=2026-05-30T10:00:00Z\n");
  const warnRun = run(["lock", "acquire"], { home, cwd, env: { HOSTNAME: "mybox" } });
  chkTrue("lock warns another machine active", warnRun.all.includes("another machine looks active"));
  chkTrue("lock names the other host", warnRun.all.includes("otherbox"));
  chkTrue("lock acquire never blocks (exit 0)", warnRun.code === 0);
  chk("lock did not overwrite other host's fresh lock", "host=otherbox\nacquired=2026-05-30T10:00:00Z\n", fs.readFileSync(lock, "utf8"));

  // A fresh-but-hours-old lock from another host exercises the "XhYm" age
  // formatting and still warns (age 2h, well within the 8h TTL).
  fs.writeFileSync(lock, "host=otherbox\nacquired=2026-05-30T08:00:00Z\n");
  const twoHrsAgo = new Date(Date.now() - 2 * 3600 * 1000 - 5 * 60 * 1000);
  fs.utimesSync(lock, twoHrsAgo, twoHrsAgo);
  const ageRun = run(["lock", "acquire"], { home, cwd, env: { HOSTNAME: "mybox", CLAUDE_MEMORY_LOCK_TTL_HOURS: "8" } });
  chkTrue("lock prints an hours-and-minutes age", /Lock age: 2h\d+m/.test(ageRun.all));

  // release from a DIFFERENT host must not delete the other host's lock.
  run(["lock", "release"], { home, cwd, env: { HOSTNAME: "mybox" } });
  chkTrue("release leaves another host's lock intact", fs.existsSync(lock));

  // A LOCK file with NO host= field: readField returns "" so there is no
  // other-host conflict -> we simply (re)take it without warning.
  fs.writeFileSync(lock, "acquired=2026-05-30T10:00:00Z\n");
  const noHost = run(["lock", "acquire"], { home, cwd, env: { HOSTNAME: "mybox" } });
  chk("lock with no host field never warns", false, noHost.all.includes("another machine"));
  chk("lock with no host field is taken by us", "mybox", fs.readFileSync(lock, "utf8").match(/host=(.*)/)[1]);

  // A STALE lock (older than TTL) from another host -> safe to take over.
  fs.writeFileSync(lock, "host=otherbox\nacquired=2020-01-01T00:00:00Z\n");
  const oldTime = new Date(Date.now() - 100 * 3600 * 1000);
  fs.utimesSync(lock, oldTime, oldTime);
  run(["lock", "acquire"], { home, cwd, env: { HOSTNAME: "mybox", CLAUDE_MEMORY_LOCK_TTL_HOURS: "8" } });
  chk("stale lock taken over by this host", "mybox", fs.readFileSync(lock, "utf8").match(/host=(.*)/)[1]);

  // Own-host release removes it.
  run(["lock", "release"], { home, cwd, env: { HOSTNAME: "mybox" } });
  chk("own-host release removes lock", false, fs.existsSync(lock));

  // lock on a non-set-up memory (no link) is a silent no-op.
  const home2 = sandbox();
  const cwd2 = sandbox();
  const r2 = run(["lock", "acquire"], { home: home2, cwd: cwd2 });
  chk("lock no-op when not set up exits 0", 0, r2.code);
}

console.log("\n########## CLI: doctor on empty target ##########");
{
  const home = sandbox();
  const cwd = sandbox();
  const mem = memDir(home, cwd);
  // Make memory a link to an empty cloud dir -> doctor flags eviction.
  const cloud = path.join(home, "Dropbox", "_SYSTEM", "claude-memory");
  fs.mkdirSync(cloud, { recursive: true });
  fs.mkdirSync(path.dirname(mem), { recursive: true });
  fs.symlinkSync(cloud, mem, "dir");
  const doc = run(["doctor"], { home, cwd });
  chk("doctor empty target exits 1", 1, doc.code);
  chkTrue("doctor empty target flags EMPTY", doc.all.includes("EMPTY"));
}

console.log("\n########## CLI: merge dry-run ##########");
{
  const home = sandbox();
  const cwd = sandbox();
  const mem = memDir(home, cwd);
  fs.mkdirSync(mem, { recursive: true });
  fs.writeFileSync(path.join(mem, "only-local.md"), "L\n");
  fs.writeFileSync(path.join(mem, "MEMORY.md"), "- a\n- local\n");

  const cloud = path.join(home, "Dropbox", "_SYSTEM", "claude-memory");
  fs.mkdirSync(cloud, { recursive: true });
  fs.writeFileSync(path.join(cloud, "MEMORY.md"), "- a\n- cloud\n");
  fs.mkdirSync(path.join(home, "Dropbox"), { recursive: true });

  const dry = run(["merge", "--provider", "dropbox", "--dry-run"], { home, cwd });
  chk("merge dry-run exits 0", 0, dry.code);
  chkTrue("merge dry-run announces dry run", dry.all.toLowerCase().includes("dry run"));
  chkTrue("merge dry-run plans a copy", dry.all.includes("only-local.md"));
  // Dry run must not write anything into the cloud target.
  chk("merge dry-run wrote nothing", false, fs.existsSync(path.join(cloud, "only-local.md")));
}

console.log("\n########## CLI: setup variants ##########");
{
  // No existing local memory -> a fresh link is created (no backup needed).
  const home = sandbox();
  const cwd = sandbox();
  const mem = memDir(home, cwd);
  fs.mkdirSync(path.join(home, "Dropbox"), { recursive: true });
  const r = run(["setup", "--provider", "dropbox"], { home, cwd });
  chk("fresh setup exits 0", 0, r.code);
  chkTrue("fresh setup notes no existing dir", r.all.includes("No existing memory"));
  chkTrue("fresh setup links", r.all.includes("Linked:"));
  chkTrue("fresh link is a symlink", fs.lstatSync(mem).isSymbolicLink());
}
{
  // Both sides populated -> setup MERGES instead of overwriting.
  const home = sandbox();
  const cwd = sandbox();
  const mem = memDir(home, cwd);
  fs.mkdirSync(mem, { recursive: true });
  fs.writeFileSync(path.join(mem, "MEMORY.md"), "- a\n- local\n");
  fs.writeFileSync(path.join(mem, "local-only.md"), "L\n");

  const cloud = path.join(home, "Dropbox", "_SYSTEM", "claude-memory");
  fs.mkdirSync(cloud, { recursive: true });
  fs.writeFileSync(path.join(cloud, "MEMORY.md"), "- a\n- cloud\n");
  fs.writeFileSync(path.join(cloud, "cloud-only.md"), "C\n");
  fs.mkdirSync(path.join(home, "Dropbox"), { recursive: true });

  const r = run(["setup", "--provider", "dropbox"], { home, cwd });
  chk("setup-merge exits 0", 0, r.code);
  chkTrue("setup-merge reports merging", r.all.includes("merging instead of overwriting"));
  chkTrue("setup-merge prints a Merge summary", r.all.includes("Merge summary"));
  chkTrue("setup-merge backs up cloud side", r.all.includes("Cloud backup written"));
  chkTrue("setup-merge brought local-only into cloud", fs.existsSync(path.join(cloud, "local-only.md")));
  chkTrue("setup-merge left cloud-only alone", fs.existsSync(path.join(cloud, "cloud-only.md")));
}
{
  // Idempotency mismatch: an existing link pointing elsewhere -> refuse (exit 1).
  const home = sandbox();
  const cwd = sandbox();
  const mem = memDir(home, cwd);
  fs.mkdirSync(path.dirname(mem), { recursive: true });
  const elsewhere = sandbox();
  fs.symlinkSync(elsewhere, mem, "dir");
  fs.mkdirSync(path.join(home, "Dropbox"), { recursive: true });
  const r = run(["setup", "--provider", "dropbox"], { home, cwd });
  chk("setup refuses a foreign link (exit 1)", 1, r.code);
  chkTrue("setup explains the mismatch", r.all.includes("points elsewhere"));
}
{
  // Missing provider mount -> clean failure (exit 1), no stack trace.
  const home = sandbox(); // no Dropbox folder here
  const cwd = sandbox();
  const r = run(["setup", "--provider", "dropbox"], { home, cwd });
  chk("setup with no mount exits 1", 1, r.code);
  chkTrue("setup with no mount explains", r.all.includes("could not locate"));
}

console.log("\n########## CLI: status & doctor edge states ##########");
{
  // Broken link -> status reports unreachable; doctor FAILs.
  const home = sandbox();
  const cwd = sandbox();
  const mem = memDir(home, cwd);
  fs.mkdirSync(path.dirname(mem), { recursive: true });
  fs.symlinkSync(path.join(home, "does-not-exist"), mem, "dir");
  const st = run(["status"], { home, cwd });
  chkTrue("status flags broken link", st.all.includes("NOT reachable"));
  const doc = run(["doctor"], { home, cwd });
  chk("doctor broken link exits 1", 1, doc.code);
  chkTrue("doctor reports link broken", doc.all.includes("link is broken"));
}
{
  // No memory at all -> doctor FAILs with "no memory found".
  const home = sandbox();
  const cwd = sandbox();
  const doc = run(["doctor"], { home, cwd });
  chk("doctor no memory exits 1", 1, doc.code);
  chkTrue("doctor says no memory found", doc.all.includes("no memory found"));
}
{
  // Memory still a real directory (never set up) -> doctor warns "run setup",
  // does not FAIL, and reports the files present.
  const home = sandbox();
  const cwd = sandbox();
  const mem = memDir(home, cwd);
  fs.mkdirSync(mem, { recursive: true });
  fs.writeFileSync(path.join(mem, "MEMORY.md"), "- x\n");
  const doc = run(["doctor"], { home, cwd });
  chk("doctor on real dir exits 0", 0, doc.code);
  chkTrue("doctor on real dir says run setup", doc.all.includes("still a real directory"));
  chkTrue("doctor on real dir still counts files", doc.all.includes("1 files present"));
}
{
  // Zero-byte placeholder files -> doctor warns about possible eviction.
  const home = sandbox();
  const cwd = sandbox();
  const mem = memDir(home, cwd);
  const cloud = path.join(home, "Dropbox", "_SYSTEM", "claude-memory");
  fs.mkdirSync(cloud, { recursive: true });
  fs.writeFileSync(path.join(cloud, "real.md"), "content\n");
  fs.writeFileSync(path.join(cloud, "placeholder.md"), ""); // zero-byte
  fs.mkdirSync(path.dirname(mem), { recursive: true });
  fs.symlinkSync(cloud, mem, "dir");
  const doc = run(["doctor"], { home, cwd });
  chk("doctor zero-byte exits 1", 1, doc.code);
  chkTrue("doctor flags zero-byte files", doc.all.includes("zero-byte"));
}

console.log("\n########## CLI: restore variants ##########");
{
  // Not a link at all -> nothing to restore (exit 1).
  const home = sandbox();
  const cwd = sandbox();
  const r = run(["restore"], { home, cwd });
  chk("restore with no link exits 1", 1, r.code);
  chkTrue("restore explains nothing to restore", r.all.includes("not a link"));
}
{
  // Already a real directory -> nothing to restore (exit 1).
  const home = sandbox();
  const cwd = sandbox();
  const mem = memDir(home, cwd);
  fs.mkdirSync(mem, { recursive: true });
  const r = run(["restore"], { home, cwd });
  chk("restore on real dir exits 1", 1, r.code);
  chkTrue("restore says already real", r.all.includes("already a real directory"));
}
{
  // Link with NO .old sibling -> restore copies data back from the cloud.
  const home = sandbox();
  const cwd = sandbox();
  const mem = memDir(home, cwd);
  const cloud = path.join(home, "Dropbox", "_SYSTEM", "claude-memory");
  fs.mkdirSync(cloud, { recursive: true });
  fs.writeFileSync(path.join(cloud, "MEMORY.md"), "- from cloud\n");
  fs.mkdirSync(path.dirname(mem), { recursive: true });
  fs.symlinkSync(cloud, mem, "dir");
  const r = run(["restore"], { home, cwd });
  chk("restore-from-cloud exits 0", 0, r.code);
  chkTrue("restore-from-cloud message", r.all.includes("copying data back from the cloud"));
  chk("restore-from-cloud yields a real dir", false, fs.lstatSync(mem).isSymbolicLink());
  chkTrue("restore-from-cloud copied MEMORY.md", fs.existsSync(path.join(mem, "MEMORY.md")));
}

console.log("\n########## CLI: merge variants ##########");
{
  // memory already a link -> nothing to merge.
  const home = sandbox();
  const cwd = sandbox();
  const mem = memDir(home, cwd);
  const cloud = path.join(home, "Dropbox", "_SYSTEM", "claude-memory");
  fs.mkdirSync(cloud, { recursive: true });
  fs.mkdirSync(path.dirname(mem), { recursive: true });
  fs.symlinkSync(cloud, mem, "dir");
  fs.mkdirSync(path.join(home, "Dropbox"), { recursive: true });
  const r = run(["merge", "--provider", "dropbox"], { home, cwd });
  chk("merge on a link exits 0", 0, r.code);
  chkTrue("merge on a link is a no-op", r.all.includes("already a link"));
}
{
  // no local memory dir -> nothing to merge (exit 1).
  const home = sandbox();
  const cwd = sandbox();
  fs.mkdirSync(path.join(home, "Dropbox"), { recursive: true });
  const r = run(["merge", "--provider", "dropbox"], { home, cwd });
  chk("merge with no local dir exits 1", 1, r.code);
  chkTrue("merge explains nothing to merge", r.all.includes("nothing to merge"));
}
{
  // cloud target empty -> nothing to merge against (exit 0, with a hint).
  const home = sandbox();
  const cwd = sandbox();
  const mem = memDir(home, cwd);
  fs.mkdirSync(mem, { recursive: true });
  fs.writeFileSync(path.join(mem, "MEMORY.md"), "- x\n");
  fs.mkdirSync(path.join(home, "Dropbox"), { recursive: true });
  const r = run(["merge", "--provider", "dropbox"], { home, cwd });
  chk("merge empty cloud exits 0", 0, r.code);
  chkTrue("merge empty cloud warns", r.all.includes("nothing to merge against"));
}
{
  // Full apply merge (not dry): backs up both sides and writes.
  const home = sandbox();
  const cwd = sandbox();
  const mem = memDir(home, cwd);
  fs.mkdirSync(mem, { recursive: true });
  fs.writeFileSync(path.join(mem, "only-local.md"), "L\n");
  const cloud = path.join(home, "Dropbox", "_SYSTEM", "claude-memory");
  fs.mkdirSync(cloud, { recursive: true });
  fs.writeFileSync(path.join(cloud, "seed.md"), "S\n");
  fs.mkdirSync(path.join(home, "Dropbox"), { recursive: true });
  const r = run(["merge", "--provider", "dropbox"], { home, cwd });
  chk("merge apply exits 0", 0, r.code);
  chkTrue("merge apply backs up local", r.all.includes("Local backup written"));
  chkTrue("merge apply backs up cloud", r.all.includes("Cloud backup written"));
  chkTrue("merge apply prints summary", r.all.includes("Merge summary"));
  chkTrue("merge apply copied local-only into cloud", fs.existsSync(path.join(cloud, "only-local.md")));
}

// Cleanup.
for (const s of sandboxes) fs.rmSync(s, { recursive: true, force: true });

console.log("\n==================================================");
console.log(`RESULT: ${pass} passed, ${fail} failed`);
console.log("==================================================");
process.exit(fail === 0 ? 0 : 1);
