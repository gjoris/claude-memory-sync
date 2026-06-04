import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";

export const PROVIDERS = ["google", "dropbox", "onedrive", "icloud"];

// OneDrive / SharePoint service path limit (full path). We warn past this.
export const ONEDRIVE_PATH_CAP = 400;

export function providerLabel(provider) {
  switch (provider) {
    case "google":
      return "Google Drive";
    case "dropbox":
      return "Dropbox";
    case "onedrive":
      return "OneDrive";
    case "icloud":
      return "iCloud Drive";
    default:
      return provider;
  }
}

// A detection result carries the resolved root plus an optional non-fatal
// caveat (e.g. a third-party Linux mount whose offline guarantee depends on the
// tool's cache). A fatal, already-explained failure is thrown as ProviderError.
export class ProviderError extends Error {}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function firstExistingDir(...candidates) {
  for (const c of candidates) {
    if (c && isDir(c)) return c;
  }
  return null;
}

function home() {
  return os.homedir();
}

function osFamily() {
  switch (process.platform) {
    case "darwin":
      return "macos";
    case "linux":
      return "linux";
    case "win32":
      return "windows";
    default:
      return "other";
  }
}

// --- Google Drive -----------------------------------------------------------

// Localized names for the "My Drive" subfolder.
const GOOGLE_DRIVE_NAMES = ["My Drive", "Mijn Drive", "Mon Drive", "Meine Ablage", "Mi unidad"];

function googleRootMac(account) {
  const cs = path.join(home(), "Library", "CloudStorage");
  let mount = null;
  if (account) {
    const m = path.join(cs, `GoogleDrive-${account}`);
    if (isDir(m)) mount = m;
  }
  if (!mount) {
    let entries = [];
    try {
      entries = fs.readdirSync(cs);
    } catch {
      entries = [];
    }
    for (const name of entries) {
      if (!name.startsWith("GoogleDrive-")) continue;
      if (name.includes("(")) continue; // skip dated duplicate leftovers
      const full = path.join(cs, name);
      if (isDir(full)) {
        mount = full;
        break;
      }
    }
  }
  if (!mount) return null;

  const drive = firstExistingDir(...GOOGLE_DRIVE_NAMES.map((n) => path.join(mount, n)));
  if (drive) return drive;
  // Last resort: first directory inside the mount.
  try {
    for (const name of fs.readdirSync(mount)) {
      const full = path.join(mount, name);
      if (isDir(full)) return full;
    }
  } catch {
    /* ignore */
  }
  return null;
}

function googleRootWindows(account) {
  const candidateRoots = [];
  // Every filesystem drive letter (Drive for desktop mounts a virtual drive).
  try {
    const out = execFileSync("powershell", [
      "-NoProfile",
      "-Command",
      "(Get-PSDrive -PSProvider FileSystem).Root",
    ], { encoding: "utf8" });
    for (const line of out.split(/\r?\n/)) {
      const r = line.trim();
      if (r) candidateRoots.push(r);
    }
  } catch {
    // Fall back to common drive letters if PowerShell is unavailable.
    for (const letter of ["C:\\", "G:\\", "H:\\"]) candidateRoots.push(letter);
  }
  if (process.env.USERPROFILE) {
    candidateRoots.push(path.join(process.env.USERPROFILE, "Google Drive"));
  }
  for (const root of candidateRoots) {
    if (!root) continue;
    for (const name of GOOGLE_DRIVE_NAMES) {
      const cand = path.join(root, name);
      if (isDir(cand)) return cand;
    }
  }
  return null;
}

// Linux: no official client. Detect a known third-party mount and warn.
function googleRootLinux(account) {
  let found = null;
  if (account && isDir(path.join(home(), "Insync", account))) {
    found = path.join(home(), "Insync", account);
  }
  if (!found) {
    // Insync per-account subfolders (name@domain), then common rclone spots.
    const insync = path.join(home(), "Insync");
    if (isDir(insync)) {
      try {
        for (const name of fs.readdirSync(insync)) {
          if (name.includes("@") && isDir(path.join(insync, name))) {
            found = path.join(insync, name);
            break;
          }
        }
      } catch {
        /* ignore */
      }
    }
    found =
      found ||
      firstExistingDir(
        path.join(home(), "Insync"),
        path.join(home(), "google-drive"),
        path.join(home(), "gdrive"),
        path.join(home(), "GoogleDrive"),
        path.join(home(), "Google Drive"),
      );
  }
  if (!found) {
    throw new ProviderError(
      "Google Drive has no official Linux client. Set up rclone or Insync first (see docs/), or use Dropbox, which is the only one of the four with an official Linux client. Looked for: ~/Insync, ~/google-drive, ~/gdrive, ~/GoogleDrive.",
    );
  }
  let warning;
  if (found.startsWith(path.join(home(), "Insync"))) {
    warning =
      "Using an Insync folder on Linux. Insync keeps real files on disk, but confirm this account is set to download (not selective-sync away) the target folder so Claude never reads an empty directory.";
  } else if (isRcloneMount(found)) {
    warning = rcloneWarning(found);
  } else {
    warning =
      `'${found}' is a third-party Google Drive folder on Linux. The offline guarantee depends entirely on that tool's caching, which this tool cannot verify. Confirm the folder keeps real local copies.`;
  }
  return { root: found, warning };
}

// --- Dropbox ----------------------------------------------------------------

function dropboxRoot(account) {
  if (osFamily() === "windows") {
    const up = process.env.USERPROFILE || home();
    return firstExistingDir(
      account && path.join(up, `Dropbox (${account})`),
      account && path.join(up, `Dropbox - ${account}`),
      path.join(up, "Dropbox"),
      path.join(up, "Dropbox (Personal)"),
    );
  }
  // macOS + Linux: ~/Dropbox, or the newer File Provider location on macOS.
  return firstExistingDir(
    path.join(home(), "Dropbox"),
    path.join(home(), "Library", "CloudStorage", "Dropbox"),
  );
}

// --- OneDrive ---------------------------------------------------------------

function onedriveRootMac(account) {
  const cs = path.join(home(), "Library", "CloudStorage");
  if (account) {
    const hit = firstExistingDir(
      path.join(cs, `OneDrive-${account}`),
      path.join(home(), `OneDrive-${account}`),
    );
    if (hit) return hit;
  }
  const personal = path.join(cs, "OneDrive-Personal");
  if (isDir(personal)) return personal;
  // First OneDrive-* org mount under CloudStorage.
  try {
    for (const name of fs.readdirSync(cs)) {
      if (name.startsWith("OneDrive-") && isDir(path.join(cs, name))) {
        return path.join(cs, name);
      }
    }
  } catch {
    /* ignore */
  }
  return firstExistingDir(path.join(home(), "OneDrive"));
}

function onedriveRootWindows(account) {
  const up = process.env.USERPROFILE || home();
  const candidates = [];
  if (account) {
    candidates.push(path.join(up, `OneDrive - ${account}`));
    candidates.push(path.join(up, `OneDrive-${account}`));
  }
  candidates.push(path.join(up, "OneDrive"));
  if (process.env.OneDrive) candidates.push(process.env.OneDrive);
  if (process.env.OneDriveConsumer) candidates.push(process.env.OneDriveConsumer);
  if (process.env.OneDriveCommercial) candidates.push(process.env.OneDriveCommercial);
  const hit = firstExistingDir(...candidates);
  if (hit) return hit;
  // First "OneDrive - *" org folder under the profile.
  try {
    for (const name of fs.readdirSync(up)) {
      if (name.startsWith("OneDrive - ") && isDir(path.join(up, name))) {
        return path.join(up, name);
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

function onedriveRootLinux(account) {
  let found = null;
  if (account) {
    found = firstExistingDir(
      path.join(home(), `OneDrive-${account}`),
      path.join(home(), `OneDrive - ${account}`),
    );
  }
  if (!found) {
    found = firstExistingDir(
      path.join(home(), "OneDrive"),
      path.join(home(), "onedrive"),
      path.join(home(), "OneDrive-Personal"),
    );
  }
  if (!found) {
    throw new ProviderError(
      "OneDrive has no official Linux client. Set up the abraunegg 'onedrive' client or rclone first (see docs/), or use Dropbox, which is the only one of the four with an official Linux client. Looked for: ~/OneDrive, ~/onedrive, ~/OneDrive-Personal.",
    );
  }
  const warning = isRcloneMount(found)
    ? rcloneWarning(found)
    : "Using a third-party OneDrive folder on Linux (e.g. the abraunegg client). This keeps real files on disk, but confirm the sync includes the target folder so Claude never reads an empty directory; the offline guarantee depends on that tool, not on this tool.";
  return { root: found, warning };
}

// --- iCloud -----------------------------------------------------------------

function icloudRoot() {
  if (osFamily() === "linux") {
    throw new ProviderError(
      "iCloud Drive has no Linux client (web-only). There is no local iCloud folder to sync on Linux. Dropbox is the only one of the four with an official Linux client.",
    );
  }
  if (osFamily() === "windows") {
    const up = process.env.USERPROFILE || home();
    return firstExistingDir(path.join(up, "iCloudDrive"), path.join(up, "iCloud Drive"));
  }
  return firstExistingDir(path.join(home(), "Library", "Mobile Documents", "com~apple~CloudDocs"));
}

// --- rclone detection (Linux) -----------------------------------------------

function rcloneWarning(p) {
  return `'${p}' looks like an rclone mount. An rclone VFS mount is NOT a durable local copy unless it runs with --vfs-cache-mode full and the files have actually been cached; without that, Claude can read empty/uncached files when the remote is unreachable. Make sure your rclone mount caches this folder.`;
}

// Best-effort: is the path covered by an rclone FUSE mount? Scans `mount`.
export function isRcloneMount(p) {
  if (osFamily() !== "linux") return false;
  let out;
  try {
    out = execFileSync("mount", [], { encoding: "utf8" });
  } catch {
    return false;
  }
  const target = p.replace(/\/+$/, "");
  for (const line of out.split(/\r?\n/)) {
    if (!/rclone|fuse\.rclone/i.test(line)) continue;
    // "<source> on <mountpoint> type fuse.rclone (...)"
    const m = line.match(/ on (.+?) type /);
    if (!m) continue;
    const mp = m[1].replace(/\/+$/, "");
    if (target === mp || target.startsWith(mp + "/")) return true;
  }
  return false;
}

// Resolve a provider's sync root. Returns { root, warning }. Throws
// ProviderError with an actionable message when the provider is unsupported on
// the current OS or no mount is found.
export function providerRoot(provider, account = "") {
  const fam = osFamily();
  switch (provider) {
    case "google": {
      if (fam === "linux") return googleRootLinux(account);
      const root = fam === "windows" ? googleRootWindows(account) : googleRootMac(account);
      return { root, warning: null };
    }
    case "dropbox":
      return { root: dropboxRoot(account), warning: null };
    case "onedrive": {
      if (fam === "linux") return onedriveRootLinux(account);
      const root = fam === "windows" ? onedriveRootWindows(account) : onedriveRootMac(account);
      return { root, warning: null };
    }
    case "icloud":
      return { root: icloudRoot(), warning: null };
    default:
      return { root: null, warning: null };
  }
}

// Provider-specific manual "make available offline" instruction.
export function offlineInstruction(provider) {
  switch (provider) {
    case "google":
      return `Google Drive:
  In Google Drive settings, set My Drive syncing options to "Mirror files"
  (Preferences -> Folders from Drive). With mirroring the files are real local
  files, always available offline even when the Drive app is not running.
  Streaming + "Available offline" is NOT enough: streamed files vanish when the
  Drive app is closed, leaving Claude an empty directory.`;
    case "onedrive":
      return `OneDrive (Files On-Demand):
  Right-click the "claude-memory" folder in Finder/Explorer and choose
  "Always keep on this device".`;
    case "icloud":
      return `iCloud Drive:
  Control-click the "claude-memory" folder and choose "Keep Downloaded". Also
  confirm System Settings -> Apple ID -> iCloud Drive does not have "Optimize
  Mac Storage" evicting it. (brctl download forces a one-time download but does
  NOT pin — only "Keep Downloaded" is durable.)`;
    case "dropbox":
      return `Dropbox (Smart Sync / Selective Sync):
  Right-click the "claude-memory" folder and set it to "Make available offline"
  / "Local" (not "Online-only"). Note: Dropbox on Windows does not sync
  junctions/symlinks placed inside the Dropbox folder, but that does not affect
  this tool — the link lives OUTSIDE Dropbox and just points in.`;
    default:
      return 'Mark the synced "claude-memory" folder as available offline in your provider.';
  }
}
