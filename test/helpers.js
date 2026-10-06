'use strict';

// Shared test fixtures. The core layer takes `io` by injection, so a plain
// in-memory implementation exercises it without touching the disk.

const MEMORY = '.workflow/memory';
const INBOX = '.workflow/memory-inbox';

/**
 * In-memory `io` with the same shape the plugin process and the agent
 * extension provide. Paths are POSIX-style, like the plugin's own constants.
 *
 * @param {Record<string,string>} initial
 * @param {{failWrite?: (source: string) => boolean}} [options]
 */
function memoryIo(initial = {}, options = {}) {
  const files = new Map(Object.entries(initial));

  const isDir = dir => {
    if (files.has(dir)) return false;
    const prefix = `${dir}/`;
    for (const key of files.keys()) if (key.startsWith(prefix)) return true;
    return false;
  };

  const notFound = source => {
    const error = new Error(`path not found: ${source}`);
    error.code = 'NOT_FOUND';
    return error;
  };

  const list = async dir => {
    if (!isDir(dir)) throw notFound(dir);
    const prefix = `${dir}/`;
    const seen = new Map();
    for (const key of files.keys()) {
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      const name = rest.split('/')[0];
      if (seen.has(name)) continue;
      const directory = rest.includes('/');
      seen.set(name, {
        name,
        path: `${dir}/${name}`,
        isDirectory: directory,
        size: directory ? 0 : Buffer.byteLength(files.get(key), 'utf8'),
      });
    }
    return [...seen.values()];
  };

  const read = async source => {
    if (!files.has(source)) throw notFound(source);
    return files.get(source);
  };

  return {
    files,
    snapshot: () => Object.fromEntries(files),
    reader: { list, read },
    readText: read,
    writeText: async (source, content) => {
      if (options.failWrite?.(source)) {
        const error = new Error(`simulated write failure: ${source}`);
        error.code = 'EIO';
        throw error;
      }
      files.set(source, String(content));
    },
    exists: async source => files.has(source) || isDir(source),
    remove: async source => { files.delete(source); },
  };
}

/** A memory entry shaped exactly like `core.parseEntry` produces. */
function makeEntry(overrides = {}) {
  const id = overrides.id ?? 'LSN-20260101-sample';
  return {
    id,
    kind: overrides.kind ?? 'lesson',
    title: overrides.title ?? 'Sample entry',
    keywords: overrides.keywords ?? [],
    status: overrides.status ?? 'active',
    pinned: overrides.pinned ?? false,
    summary: overrides.summary ?? 'Sample summary',
    body: overrides.body ?? 'Sample body',
    source: overrides.source ?? `${MEMORY}/${id}.md`,
    created: overrides.created ?? '2026-01-01',
    related: overrides.related ?? [],
    supersededBy: overrides.supersededBy ?? null,
    batchRef: overrides.batchRef ?? null,
  };
}

/** A markdown file for the fake corpus. */
function mdFile(id, { kind = 'lesson', title = 'Sample entry', body = 'Body text', keywords = [], extra = '' } = {}) {
  return [
    '---',
    `id: "${id}"`,
    `kind: ${kind}`,
    `title: "${title}"`,
    `keywords: [${keywords.join(', ')}]`,
    'status: active',
    extra,
    '---',
    '',
    body,
    '',
  ].filter(line => line !== '').join('\n');
}

module.exports = { memoryIo, makeEntry, mdFile, MEMORY, INBOX };
