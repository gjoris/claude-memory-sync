// Isolated end-to-end test of the Node CLI. Overrides HOME so the real
// ~/.claude is NEVER touched. Reproduces the cross-machine scenario: machine B
// has its own local memory; the cloud target already has memory from machine A.
//
// Run with: node test/merge.test.js
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, "..", "bin", "claude-memory-sync.js");
const NODE = process.execPath;

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
function chkFile(desc, p) {
  if (fs.existsSync(p) && fs.statSync(p).isFile()) {
    console.log(`PASS  ${desc}`);
    pass++;
  } else {
    console.log(`FAIL  ${desc}  (missing: ${p})`);
    fail++;
  }
}
function chkNoFile(desc, p) {
  if (!fs.existsSync(p)) {
    console.log(`PASS  ${desc}`);
    pass++;
  } else {
    console.log(`FAIL  ${desc}  (should not exist: ${p})`);
    fail++;
  }
}

function run(home, args) {
  return execFileSync(NODE, [CLI, ...args], {
    env: { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: "1" },
    cwd: path.join(home, "work"),
    encoding: "utf8",
  });
}

function slug(cwd) {
  return cwd.replace(/[\\/]/g, "-");
}

function mkSandbox() {
  // realpath so the slug matches process.cwd() inside the CLI (macOS maps
  // /var/folders -> /private/var/folders).
  const sbx = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cms-node-")));
  const work = path.join(sbx, "work");
  fs.mkdirSync(work, { recursive: true });
  return sbx;
}

function memPathFor(home) {
  const work = path.join(home, "work");
  return path.join(home, ".claude", "projects", slug(work), "memory");
}

const HOST = (() => {
  let h = (os.hostname() || "").split(".")[0].replace(/[^A-Za-z0-9_-]/g, "-").replace(/-+$/, "");
  return h || "host";
})();

// ===========================================================================
// Scenario 1: explicit `merge` against an already-populated cloud target.
// ===========================================================================
const sbx = mkSandbox();
const MEM = memPathFor(sbx);
const CLOUD = path.join(sbx, "Dropbox", "_SYSTEM", "claude-memory");

fs.mkdirSync(MEM, { recursive: true });
fs.writeFileSync(path.join(MEM, "local_only.md"), "local-only content\n");
fs.writeFileSync(path.join(MEM, "identical.md"), "same on both sides\n");
fs.writeFileSync(path.join(MEM, "conflict.md"), "LOCAL version of conflict\n");
fs.writeFileSync(
  path.join(MEM, "MEMORY.md"),
  "- [Shared](shared.md) — in both\n- [LocalNote](local_only.md) — only on machine B\n",
);

fs.mkdirSync(CLOUD, { recursive: true });
fs.writeFileSync(path.join(CLOUD, "cloud_only.md"), "cloud-only content\n");
fs.writeFileSync(path.join(CLOUD, "identical.md"), "same on both sides\n");
fs.writeFileSync(path.join(CLOUD, "conflict.md"), "CLOUD version of conflict\n");
fs.writeFileSync(
  path.join(CLOUD, "MEMORY.md"),
  "- [Shared](shared.md) — in both\n- [CloudNote](cloud_only.md) — only on machine A\n",
);

const KEEP = `conflict.from-${HOST}.md`;

console.log("########## TEST 1: merge --dry-run (must write NOTHING) ##########");
const before = fs.readdirSync(CLOUD).sort().join(",");
run(sbx, ["merge", "--provider", "dropbox", "--dry-run"]);
const after = fs.readdirSync(CLOUD).sort().join(",");
chk("dry-run leaves cloud dir unchanged", before, after);
chkNoFile("dry-run did not create keep-both copy", path.join(CLOUD, KEEP));

console.log("\n########## TEST 2: real merge ##########");
run(sbx, ["merge", "--provider", "dropbox"]);
chkFile("local-only copied into cloud", path.join(CLOUD, "local_only.md"));
chk("local-only content correct", "local-only content\n", fs.readFileSync(path.join(CLOUD, "local_only.md"), "utf8"));
chkFile("cloud-only preserved", path.join(CLOUD, "cloud_only.md"));
chk("cloud-only content untouched", "cloud-only content\n", fs.readFileSync(path.join(CLOUD, "cloud_only.md"), "utf8"));
chkFile("identical still present", path.join(CLOUD, "identical.md"));
chk("conflict: cloud keeps canonical name", "CLOUD version of conflict\n", fs.readFileSync(path.join(CLOUD, "conflict.md"), "utf8"));
chkFile("conflict: local saved as keep-both", path.join(CLOUD, KEEP));
chk("keep-both holds LOCAL content", "LOCAL version of conflict\n", fs.readFileSync(path.join(CLOUD, KEEP), "utf8"));

const mem = fs.readFileSync(path.join(CLOUD, "MEMORY.md"), "utf8");
const count = (re) => (mem.match(re) || []).length;
chk("MEMORY.md: Shared line not duplicated", 1, count(/\[Shared\]/g));
chk("MEMORY.md: LocalNote unioned in", 1, count(/\[LocalNote\]/g));
chk("MEMORY.md: CloudNote preserved", 1, count(/\[CloudNote\]/g));

const lbk = fs.readdirSync(path.dirname(MEM)).filter((f) => f.startsWith("memory.backup-")).length;
const cbk = fs.readdirSync(path.dirname(CLOUD)).filter((f) => f.startsWith("claude-memory.backup-")).length;
chk("local backup created", 1, lbk);
chk("cloud backup created", 1, cbk);

console.log("\n########## TEST 3: collision suffix -2 ##########");
fs.writeFileSync(path.join(MEM, "conflict.md"), "LOCAL version TWO\n");
run(sbx, ["merge", "--provider", "dropbox"]);
chkFile("collision suffix -2 created", path.join(CLOUD, `conflict.from-${HOST}-2.md`));

// ===========================================================================
// Scenario 2: setup auto-merge path (fresh sandbox).
// ===========================================================================
console.log("\n########## TEST 4: setup auto-merge path ##########");
const sbx2 = mkSandbox();
const MEM2 = memPathFor(sbx2);
const CLOUD2 = path.join(sbx2, "Dropbox", "_SYSTEM", "claude-memory");
fs.mkdirSync(MEM2, { recursive: true });
fs.mkdirSync(CLOUD2, { recursive: true });
fs.writeFileSync(path.join(MEM2, "b_local.md"), "B local\n");
fs.writeFileSync(path.join(CLOUD2, "a_cloud.md"), "A cloud\n");
fs.writeFileSync(path.join(MEM2, "dup.md"), "b version\n");
fs.writeFileSync(path.join(CLOUD2, "dup.md"), "a version\n");

run(sbx2, ["setup", "--provider", "dropbox"]);
chk("setup: memory is now a link", true, fs.lstatSync(MEM2).isSymbolicLink());
chkFile("setup-merge: A's cloud file preserved", path.join(CLOUD2, "a_cloud.md"));
chkFile("setup-merge: B's local file copied in", path.join(CLOUD2, "b_local.md"));
chkFile("setup-merge: dup kept-both", path.join(CLOUD2, `dup.from-${HOST}.md`));
chk("setup-merge: dup canonical = cloud(A)", "a version\n", fs.readFileSync(path.join(CLOUD2, "dup.md"), "utf8"));
chkFile("setup: read-through works via link", path.join(MEM2, "a_cloud.md"));
const lbk2 = fs.readdirSync(path.dirname(MEM2)).filter((f) => f.startsWith("memory.backup-")).length;
const cbk2 = fs.readdirSync(path.dirname(CLOUD2)).filter((f) => f.startsWith("claude-memory.backup-")).length;
chk("setup: local backup created", 1, lbk2);
chk("setup: cloud backup created", 1, cbk2);

// Cleanup.
fs.rmSync(sbx, { recursive: true, force: true });
fs.rmSync(sbx2, { recursive: true, force: true });

console.log("\n==================================================");
console.log(`RESULT: ${pass} passed, ${fail} failed`);
console.log("==================================================");
process.exit(fail === 0 ? 0 : 1);
