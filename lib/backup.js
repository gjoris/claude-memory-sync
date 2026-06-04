import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

// A minimal, dependency-free tar.gz writer. We only ever archive a flat-ish
// memory directory (top-level .md files, possibly a LOCK), so a small USTAR
// implementation is enough and avoids pulling in a tar dependency just to make
// a safety backup. Produces a real .tar.gz that `tar -xzf` can extract.

function octal(value, length) {
  // length includes the trailing space/NUL terminator slot.
  const str = value.toString(8).padStart(length - 1, "0");
  return str + "\0";
}

function tarHeader(name, size, mtime, type = "0") {
  const buf = Buffer.alloc(512, 0);
  buf.write(name, 0, 100, "utf8"); // name
  // Directories need the execute/search bit or their contents are unreadable
  // after extraction; regular files stay 0644.
  buf.write(type === "5" ? "0000755" : "0000644", 100, 7, "ascii"); // mode
  buf.write(octal(0, 8), 108, 8, "ascii"); // uid
  buf.write(octal(0, 8), 116, 8, "ascii"); // gid
  buf.write(octal(size, 12), 124, 12, "ascii"); // size
  buf.write(octal(Math.floor(mtime), 12), 136, 12, "ascii"); // mtime
  buf.write("        ", 148, 8, "ascii"); // checksum placeholder (spaces)
  buf.write(type, 156, 1, "ascii"); // typeflag
  buf.write("ustar\0", 257, 6, "ascii"); // magic
  buf.write("00", 263, 2, "ascii"); // version

  // Checksum: sum of all header bytes with the checksum field as spaces.
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += buf[i];
  buf.write(octal(sum, 7), 148, 7, "ascii");
  buf[155] = 0x20; // trailing space after the NUL
  return buf;
}

// Recursively collect files under dir, returning [{ archivePath, fullPath, isDir }].
function walk(dir, baseName) {
  const out = [];
  const stack = [{ abs: dir, rel: baseName }];
  while (stack.length) {
    const { abs, rel } = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    // Record the directory itself (so empty dirs survive a round-trip).
    out.push({ archivePath: rel.replace(/\\/g, "/") + "/", fullPath: abs, isDir: true });
    for (const ent of entries) {
      const childAbs = path.join(abs, ent.name);
      const childRel = `${rel}/${ent.name}`;
      const st = fs.statSync(childAbs); // follow links so backups capture data
      if (st.isDirectory()) {
        stack.push({ abs: childAbs, rel: childRel });
      } else if (st.isFile()) {
        out.push({ archivePath: childRel.replace(/\\/g, "/"), fullPath: childAbs, isDir: false });
      }
    }
  }
  return out;
}

// Write a tar.gz of `dir` (archived under its own basename) to `outPath`.
export function backupDir(dir, outPath) {
  const baseName = path.basename(dir);
  const items = walk(dir, baseName);
  const chunks = [];

  for (const item of items) {
    const st = fs.statSync(item.fullPath);
    const mtime = st.mtimeMs / 1000;
    if (item.isDir) {
      chunks.push(tarHeader(item.archivePath, 0, mtime, "5"));
    } else {
      const data = fs.readFileSync(item.fullPath);
      chunks.push(tarHeader(item.archivePath, data.length, mtime, "0"));
      chunks.push(data);
      const pad = (512 - (data.length % 512)) % 512;
      if (pad) chunks.push(Buffer.alloc(pad, 0));
    }
  }
  // Two zero blocks terminate the archive.
  chunks.push(Buffer.alloc(1024, 0));

  const tar = Buffer.concat(chunks);
  const gz = zlib.gzipSync(tar);
  fs.writeFileSync(outPath, gz);
}

// A filesystem-safe timestamp: YYYYMMDD-HHMMSS in local time.
export function timestamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}
