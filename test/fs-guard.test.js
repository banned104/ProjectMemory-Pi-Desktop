'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { createProjectFs } = require('../plugin/fs-guard.js');

const MEMORY = '.workflow/memory';
const INBOX = '.workflow/memory-inbox';

/** A throwaway project directory, removed when the test ends. */
async function project(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'pm-guard-'));
  await fsp.mkdir(path.join(root, MEMORY), { recursive: true });
  t.after(() => fsp.rm(root, { recursive: true, force: true }).catch(() => {}));
  return root;
}

const write = async (root, rel, content) => {
  const full = path.join(root, ...rel.split('/'));
  await fsp.mkdir(path.dirname(full), { recursive: true });
  await fsp.writeFile(full, content, 'utf8');
};
const read = (root, rel) => fsp.readFile(path.join(root, ...rel.split('/')), 'utf8');

/** Symlinks need Developer Mode or elevation on Windows; skip when refused. */
async function trySymlink(target, linkPath, type) {
  try {
    await fsp.symlink(target, linkPath, type);
    return true;
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) return false;
    throw error;
  }
}

test('list and read return the corpus', async t => {
  const root = await project(t);
  await write(root, `${MEMORY}/a.md`, 'alpha');
  await write(root, `${MEMORY}/b.md`, 'beta');
  const io = createProjectFs(root, 'session-1');

  const listed = await io.reader.list(MEMORY);
  assert.deepEqual(listed.map(e => e.name).sort(), ['a.md', 'b.md']);
  assert.equal(listed.every(e => e.isDirectory === false), true);
  assert.equal(listed.every(e => e.size > 0), true);

  assert.equal(await io.readText(`${MEMORY}/a.md`), 'alpha');
  assert.equal(await io.exists(`${MEMORY}/a.md`), true);
  assert.equal(await io.exists(`${MEMORY}/missing.md`), false);
});

test('list reports subdirectories and read descends into them', async t => {
  const root = await project(t);
  await write(root, `${MEMORY}/sub/deep.md`, 'deep');
  const io = createProjectFs(root, 'session-1');
  const listed = await io.reader.list(MEMORY);
  assert.equal(listed.find(e => e.name === 'sub').isDirectory, true);
  assert.equal(await io.readText(`${MEMORY}/sub/deep.md`), 'deep');
});

test('relative traversal and absolute paths are refused', async t => {
  const root = await project(t);
  await write(root, 'secret.txt', 'do not read me');
  const io = createProjectFs(root, 'session-1');

  for (const bad of ['../secret.txt', `${MEMORY}/../../secret.txt`, '/etc/passwd', 'C:/Windows/win.ini', `${MEMORY}\\a.md`, '', '.', './a.md']) {
    await assert.rejects(() => io.readText(bad), error => error.code === 'E_ESCAPE', `expected ${JSON.stringify(bad)} to be refused`);
  }
  await assert.rejects(() => io.reader.list('../'), error => error.code === 'E_ESCAPE');
});

test('writes are confined to the two memory directories', async t => {
  const root = await project(t);
  const io = createProjectFs(root, 'session-1');

  await assert.rejects(() => io.writeText('secret.txt', 'nope'), error => error.code === 'E_NOTWRITABLE');
  await assert.rejects(() => io.writeText('.workflow/other/x.md', 'nope'), error => error.code === 'E_NOTWRITABLE');
  // `..` is caught by the path parser before the writable check, so it is an escape.
  await assert.rejects(() => io.writeText('../outside.md', 'nope'), error => error.code === 'E_ESCAPE');
  await assert.rejects(() => io.remove('secret.txt'), error => error.code === 'E_NOTWRITABLE');

  await io.writeText(`${MEMORY}/ok.md`, 'fine');
  assert.equal(await read(root, `${MEMORY}/ok.md`), 'fine');
  await io.writeText(`${INBOX}/batch.json`, '{}');
  assert.equal(await read(root, `${INBOX}/batch.json`), '{}');
});

test('write creates missing directories and leaves no temp file behind', async t => {
  const root = await project(t);
  const io = createProjectFs(root, 'session-1');
  await io.writeText(`${INBOX}/nested/x.json`, 'payload');

  assert.equal(await read(root, `${INBOX}/nested/x.json`), 'payload');
  const entries = await fsp.readdir(path.join(root, INBOX, 'nested'));
  assert.deepEqual(entries, ['x.json'], 'the temp file must be renamed away, not left behind');
});

test('write replaces an existing file atomically', async t => {
  const root = await project(t);
  const io = createProjectFs(root, 'session-1');
  await io.writeText(`${MEMORY}/MAP.md`, 'first');
  await io.writeText(`${MEMORY}/MAP.md`, 'second');
  assert.equal(await read(root, `${MEMORY}/MAP.md`), 'second');
  assert.deepEqual(await fsp.readdir(path.join(root, MEMORY)), ['MAP.md']);
});

test('a symlinked directory component is refused, including the start directory', async t => {
  const root = await project(t);
  const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'pm-outside-'));
  t.after(() => fsp.rm(outside, { recursive: true, force: true }).catch(() => {}));
  await fsp.writeFile(path.join(outside, 'loot.md'), 'secret', 'utf8');

  // A directory junction needs no elevation on Windows and no privileges on POSIX.
  const nested = path.join(root, MEMORY, 'linked');
  if (!await trySymlink(outside, nested, 'junction')) {
    t.skip('symlinks are not permitted on this machine');
    return;
  }
  const io = createProjectFs(root, 'session-1');
  await assert.rejects(() => io.readText(`${MEMORY}/linked/loot.md`), error => error.code === 'E_SYMLINK');
  assert.equal(
    (await io.reader.list(MEMORY)).some(e => e.name === 'linked'),
    false,
    'a symlinked directory is never listed',
  );

  // A start directory that is itself a link.
  const dirRoot = await project(t);
  const realMemory = path.join(dirRoot, 'real-memory');
  await fsp.mkdir(realMemory, { recursive: true });
  await fsp.writeFile(path.join(realMemory, 'a.md'), 'alpha', 'utf8');
  await fsp.rm(path.join(dirRoot, MEMORY), { recursive: true, force: true });
  if (!await trySymlink(realMemory, path.join(dirRoot, MEMORY), 'junction')) return;
  const io2 = createProjectFs(dirRoot, 'session-2');
  await assert.rejects(() => io2.reader.list(MEMORY), error => error.code === 'E_SYMLINK');
  await assert.rejects(() => io2.readText(`${MEMORY}/a.md`), error => error.code === 'E_SYMLINK');
});

test('a symlinked file is refused and never listed', async t => {
  const root = await project(t);
  const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'pm-outside-'));
  t.after(() => fsp.rm(outside, { recursive: true, force: true }).catch(() => {}));
  const loot = path.join(outside, 'loot.md');
  await fsp.writeFile(loot, 'secret', 'utf8');
  if (!await trySymlink(loot, path.join(root, MEMORY, 'link.md'), 'file')) {
    t.skip('file symlinks need Developer Mode or elevation on Windows');
    return;
  }
  const io = createProjectFs(root, 'session-1');
  await assert.rejects(() => io.readText(`${MEMORY}/link.md`), error => error.code === 'E_SYMLINK');
  assert.equal((await io.reader.list(MEMORY)).some(e => e.name === 'link.md'), false);
});

test('a hard link is skipped by list and refused by read', async t => {
  const root = await project(t);
  const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'pm-outside-'));
  t.after(() => fsp.rm(outside, { recursive: true, force: true }).catch(() => {}));
  const loot = path.join(outside, 'loot.md');
  await fsp.writeFile(loot, 'secret', 'utf8');

  const hard = path.join(root, MEMORY, 'hard.md');
  try {
    await fsp.link(loot, hard);
  } catch (error) {
    t.skip(`hard links are not permitted here: ${error.code}`);
    return;
  }
  const io = createProjectFs(root, 'session-1');
  const listed = await io.reader.list(MEMORY);
  assert.equal(listed.some(e => e.name === 'hard.md'), false, 'a multiply linked file is never listed');
  await assert.rejects(() => io.readText(`${MEMORY}/hard.md`), error => error.code === 'E_HARDLINK');
});

test('files over the size cap are skipped and refused', async t => {
  const root = await project(t);
  await write(root, `${MEMORY}/big.md`, 'x'.repeat(4096));
  await write(root, `${MEMORY}/small.md`, 'ok');
  const io = createProjectFs(root, 'session-1', { maxFileBytes: 1024 });

  const listed = await io.reader.list(MEMORY);
  assert.deepEqual(listed.map(e => e.name), ['small.md']);
  await assert.rejects(() => io.readText(`${MEMORY}/big.md`), error => error.code === 'E_TOOLARGE');
});

test('a directory is not a readable file', async t => {
  const root = await project(t);
  await write(root, `${MEMORY}/sub/deep.md`, 'deep');
  const io = createProjectFs(root, 'session-1');
  await assert.rejects(() => io.readText(`${MEMORY}/sub`), error => error.code === 'E_NOTFILE');
});

test('replacing the project root invalidates the pin', async t => {
  const root = await project(t);
  await write(root, `${MEMORY}/a.md`, 'alpha');
  const io = createProjectFs(root, 'session-1');
  assert.equal(await io.readText(`${MEMORY}/a.md`), 'alpha');   // pins the root

  // Swap the directory for a different one at the same path.
  await fsp.rm(root, { recursive: true, force: true });
  await fsp.mkdir(path.join(root, MEMORY), { recursive: true });
  await fsp.writeFile(path.join(root, MEMORY, 'a.md'), 'replaced', 'utf8');

  await assert.rejects(() => io.readText(`${MEMORY}/a.md`), error => error.code === 'E_ROOTMOVED');
  await assert.rejects(() => io.reader.list(MEMORY), error => error.code === 'E_ROOTMOVED');
  await assert.rejects(() => io.writeText(`${MEMORY}/b.md`, 'x'), error => error.code === 'E_ROOTMOVED');
});

test('a missing root is reported as a moved root, not a crash', async t => {
  const root = await project(t);
  const io = createProjectFs(root, 'session-1');
  await io.exists(`${MEMORY}/a.md`);
  await fsp.rm(root, { recursive: true, force: true });
  await assert.rejects(() => io.reader.list(MEMORY), error => error.code === 'E_ROOTMOVED');
});

test('the pin is per session, so a new session re-reads the root', async t => {
  const root = await project(t);
  await write(root, `${MEMORY}/a.md`, 'alpha');
  const first = createProjectFs(root, 'session-1');
  assert.equal(await first.readText(`${MEMORY}/a.md`), 'alpha');

  const second = createProjectFs(root, 'session-2');
  assert.equal(await second.readText(`${MEMORY}/a.md`), 'alpha');
});

test('remove deletes a file inside the writable roots', async t => {
  const root = await project(t);
  const io = createProjectFs(root, 'session-1');
  await io.writeText(`${INBOX}/x.json`, '{}');
  await io.remove(`${INBOX}/x.json`);
  assert.equal(await io.exists(`${INBOX}/x.json`), false);
});
