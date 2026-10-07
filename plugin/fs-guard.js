'use strict';

// Confined file access for the agent extension.
//
// The extension runs inside the agent process with no sandbox (the host's file
// gateway only covers the plugin process), so this module *is* the security
// boundary. It is deliberately a separate file with a factory signature so it
// can be unit-tested against real temporary directories.
//
// Every read, list, write and remove:
//   - anchors on the project's real path, pinned once per session. The pin
//     records the root directory's dev/ino; each operation re-checks, before
//     and after, that the path still resolves to that same directory, so a root
//     swapped between operations is refused. The pin lives on the instance this
//     factory returns, so the caller must reuse one instance per session:
//     building a fresh one per call re-anchors on the current path and quietly
//     gives up this guarantee. Opening the project through a symlinked path is
//     allowed (that is the user's choice); links inside the project's content
//     are not.
//   - refuses a symbolic link at ANY component below the anchor, including the
//     start directories `.workflow`, `.workflow/memory`.
//   - re-resolves the result and requires it to stay inside the project.
//
// Only regular files with a single link (a hard link may point outside the
// project) and at most `maxFileBytes` are listed or read. Files are opened with
// O_NOFOLLOW|O_NONBLOCK (a FIFO cannot stall the turn) and the opened inode is
// compared with the checked path, so a swap between check and read is detected.
// Writes go to an O_EXCL|O_NOFOLLOW temp file in a directory whose canonical
// path is verified before and after, then are renamed within that directory.

const fsp = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const O_NONBLOCK = constants.O_NONBLOCK ?? 0;

const DEFAULT_MAX_FILE_BYTES = 256 * 1024;
const DEFAULT_WRITABLE = ['.workflow/memory/', '.workflow/memory-inbox/'];
const MAX_ANCHORS = 200;

const linkError = rel => Object.assign(new Error(`symlink in memory path: ${rel}`), { code: 'E_SYMLINK' });
const hardLinkError = rel => Object.assign(new Error(`hard link in memory path: ${rel}`), { code: 'E_HARDLINK' });
const notFileError = rel => Object.assign(new Error(`not a regular file: ${rel}`), { code: 'E_NOTFILE' });
const tooLargeError = (rel, max) =>
  Object.assign(new Error(`memory file too large (over ${max} bytes): ${rel}`), { code: 'E_TOOLARGE' });
const escapeError = rel => Object.assign(new Error(`path escapes the project: ${rel}`), { code: 'E_ESCAPE' });
const rootError = () => Object.assign(
  new Error('project root changed since the session started; refusing to follow it'),
  { code: 'E_ROOTMOVED' },
);
const notWritable = rel =>
  Object.assign(new Error(`write outside the memory directories: ${rel}`), { code: 'E_NOTWRITABLE' });

const inside = (base, target) => target === base || target.startsWith(`${base}${path.sep}`);

/**
 * @param {string} root session working directory
 * @param {string|undefined} sessionId scopes the pin
 * @param {{maxFileBytes?: number, writable?: string[]}} [options]
 */
function createProjectFs(root, sessionId, options = {}) {
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const writablePrefixes = options.writable ?? DEFAULT_WRITABLE;

  /** session + cwd -> { real, dev, ino }, fixed at session start or first use. */
  const anchors = new Map();
  const anchorKey = (dir, id) => `${id ?? ''}\u0000${dir}`;

  async function pinRoot(dir, id) {
    const key = anchorKey(dir, id);
    let pinned = anchors.get(key);
    if (!pinned) {
      const real = await fsp.realpath(dir);
      const stat = await fsp.lstat(real);
      if (!stat.isDirectory()) throw rootError();
      pinned = { real, dev: stat.dev, ino: stat.ino };
      anchors.set(key, pinned);
      while (anchors.size > MAX_ANCHORS) anchors.delete(anchors.keys().next().value);
    }
    return pinned;
  }

  /** The pinned real root, after confirming the path still resolves to it. */
  async function base() {
    const pinned = await pinRoot(root, sessionId);
    let current;
    let stat;
    try {
      current = await fsp.realpath(root);
      stat = await fsp.lstat(pinned.real);
    } catch { throw rootError(); }
    if (current !== pinned.real || !stat.isDirectory() || stat.dev !== pinned.dev || stat.ino !== pinned.ino) {
      throw rootError();
    }
    return pinned.real;
  }

  function partsOf(rel) {
    if (typeof rel !== 'string' || !rel || path.isAbsolute(rel) || rel.includes('\\')) throw escapeError(rel);
    const parts = rel.split('/');
    if (parts.some(part => !part || part === '.' || part === '..')) throw escapeError(rel);
    return parts;
  }

  /** lstat every component; a missing tail is allowed only where the caller creates it. */
  async function assertNoLinks(anchor, parts, rel, { missingOk = false } = {}) {
    let current = anchor;
    for (const part of parts) {
      current = path.join(current, part);
      let stat;
      try { stat = await fsp.lstat(current); }
      catch (error) { if (missingOk && error.code === 'ENOENT') return false; throw error; }
      if (stat.isSymbolicLink()) throw linkError(rel);
    }
    return true;
  }

  /** The canonical path must equal the joined path: no link anywhere in between. */
  async function assertCanonical(anchor, full, rel) {
    const real = await fsp.realpath(full);
    if (!inside(anchor, real)) throw escapeError(rel);
    if (real !== full) throw linkError(rel);
  }

  const fileProblem = (stat, rel) => (!stat.isFile() ? notFileError(rel)
    : stat.nlink > 1 ? hardLinkError(rel)
      : stat.size > maxFileBytes ? tooLargeError(rel, maxFileBytes) : null);

  async function list(rel) {
    const anchor = await base();
    const parts = partsOf(rel);
    await assertNoLinks(anchor, parts, rel);
    const full = path.join(anchor, ...parts);
    await assertCanonical(anchor, full, rel);
    const dirents = await fsp.readdir(full, { withFileTypes: true });
    const listed = [];
    for (const entry of dirents) {
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        listed.push({ name: entry.name, path: `${rel}/${entry.name}`, isDirectory: true, size: 0 });
        continue;
      }
      if (!entry.isFile()) continue;
      let stat;
      try { stat = await fsp.lstat(path.join(full, entry.name)); } catch { continue; }
      if (!fileProblem(stat, rel)) {
        listed.push({ name: entry.name, path: `${rel}/${entry.name}`, isDirectory: false, size: stat.size });
      }
    }
    await base(); // the root must not have moved while listing
    return listed;
  }

  async function read(rel) {
    const anchor = await base();
    const parts = partsOf(rel);
    await assertNoLinks(anchor, parts, rel);
    const full = path.join(anchor, ...parts);
    let handle;
    try {
      handle = await fsp.open(full, constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    } catch (error) {
      if (error.code === 'ELOOP') throw linkError(rel);
      throw error;
    }
    try {
      await assertCanonical(anchor, full, rel);
      const [opened, named] = await Promise.all([handle.stat(), fsp.stat(full)]);
      const problem = fileProblem(opened, rel);
      if (problem) throw problem;
      if (opened.ino !== named.ino || opened.dev !== named.dev) throw linkError(rel);
      const text = await handle.readFile('utf8');
      await base(); // discard what was read if the root moved meanwhile
      return text;
    } finally {
      await handle.close();
    }
  }

  function writableParts(rel) {
    const parts = partsOf(rel);
    if (!writablePrefixes.some(prefix => rel.startsWith(prefix))) throw notWritable(rel);
    return parts;
  }

  async function writeText(rel, content) {
    const anchor = await base();
    const parts = writableParts(rel);
    const dirParts = parts.slice(0, -1);
    await assertNoLinks(anchor, parts, rel, { missingOk: true });
    const dir = path.join(anchor, ...dirParts);
    await fsp.mkdir(dir, { recursive: true });
    await assertNoLinks(anchor, dirParts, rel);
    await assertCanonical(anchor, dir, rel);

    const name = parts[parts.length - 1];
    const full = path.join(dir, name);
    const temp = path.join(dir, `.${name}.${crypto.randomUUID()}.tmp`);
    const handle = await fsp.open(
      temp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW,
      0o644,
    );
    try {
      await handle.writeFile(content, 'utf8');
      // The directory must still be the one we checked, and the temp file ours.
      await assertCanonical(anchor, dir, rel);
      const [opened, named] = await Promise.all([handle.stat(), fsp.lstat(temp)]);
      if (opened.ino !== named.ino || opened.dev !== named.dev) throw linkError(rel);
    } catch (error) {
      await handle.close();
      await fsp.rm(temp, { force: true });
      throw error;
    }
    await handle.close();

    // rename would replace a symlink planted at the target rather than follow
    // it, but refuse it anyway.
    try {
      await assertNoLinks(anchor, parts, rel, { missingOk: true });
    } catch (error) {
      await fsp.rm(temp, { force: true });
      throw error;
    }
    await fsp.rename(temp, full);

    const landed = await fsp.realpath(full);
    if (landed !== full) { await fsp.rm(full, { force: true }); throw linkError(rel); }
    // A root swapped during the write means the file landed somewhere else: take it back.
    try { await base(); }
    catch (error) { await fsp.rm(full, { force: true }); throw error; }
  }

  async function exists(rel) {
    const anchor = await base();
    return assertNoLinks(anchor, partsOf(rel), rel, { missingOk: true });
  }

  async function remove(rel) {
    const anchor = await base();
    const parts = writableParts(rel);
    await assertNoLinks(anchor, parts, rel);
    await assertCanonical(anchor, path.join(anchor, ...parts.slice(0, -1)), rel);
    await fsp.unlink(path.join(anchor, ...parts));
  }

  return { reader: { list, read }, readText: read, writeText, exists, remove };
}

module.exports = { createProjectFs, DEFAULT_WRITABLE, DEFAULT_MAX_FILE_BYTES };
