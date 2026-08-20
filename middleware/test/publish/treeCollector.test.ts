import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { collectTree } from '../../packages/harness-publish/src/treeCollector.js';
import { PublishTreeTooLargeError } from '../../packages/harness-publish/src/publishManifest.js';

/**
 * Issue #581 — `collectTree` must ONLY ever call `list()`/`read()` on the
 * `Sandbox` it is given, and must recurse using the paths `list()` itself
 * returned — never an agent-supplied raw path. A fake in-memory
 * "filesystem" backing a minimal `list`/`read` pair stands in for a real
 * `Sandbox`; what matters here is the WALK logic, not the traversal guard
 * itself (that is `@omadia/sandbox`'s job and is tested there).
 */
function fakeSandbox(tree: Record<string, string>) {
  const dirs = new Set<string>(['.']);
  for (const filePath of Object.keys(tree)) {
    const parts = filePath.split('/');
    let acc = '';
    for (let i = 0; i < parts.length - 1; i += 1) {
      acc = acc === '' ? parts[i]! : `${acc}/${parts[i]}`;
      dirs.add(acc);
    }
  }
  const calls: string[] = [];
  return {
    calls,
    sandbox: {
      async list(relativePath: string) {
        calls.push(`list:${relativePath}`);
        const norm = relativePath === '.' || relativePath === '' ? '.' : relativePath;
        if (!dirs.has(norm)) return { ok: false as const, reason: 'not_found' as const, detail: 'no such dir' };
        const prefix = norm === '.' ? '' : `${norm}/`;
        const seen = new Map<string, 'dir' | 'file'>();
        for (const filePath of Object.keys(tree)) {
          if (!filePath.startsWith(prefix)) continue;
          const rest = filePath.slice(prefix.length);
          if (rest.includes('/')) seen.set(rest.split('/')[0]!, 'dir');
          else seen.set(rest, 'file');
        }
        return { ok: true as const, entries: Array.from(seen.entries()).map(([name, kind]) => ({ name, kind })) };
      },
      async read(relativePath: string) {
        calls.push(`read:${relativePath}`);
        const content = tree[relativePath];
        if (content === undefined) return { ok: false as const, reason: 'not_found' as const, detail: 'no such file' };
        return { ok: true as const, content };
      },
    },
  };
}

describe('collectTree', () => {
  it('collects a flat directory', async () => {
    const { sandbox } = fakeSandbox({ 'server.js': 'console.log(1)', 'readme.txt': 'hi' });
    const files = await collectTree(sandbox, '.', 'app');
    assert.deepEqual(
      Array.from(files.entries()).sort(),
      [
        ['readme.txt', 'hi'],
        ['server.js', 'console.log(1)'],
      ],
    );
  });

  it('recurses into subdirectories and produces POSIX-joined relative paths', async () => {
    const { sandbox } = fakeSandbox({
      'server.js': 'root',
      'public/index.html': '<html></html>',
      'public/css/style.css': 'body{}',
    });
    const files = await collectTree(sandbox, '.', 'app');
    assert.equal(files.get('public/index.html'), '<html></html>');
    assert.equal(files.get('public/css/style.css'), 'body{}');
    assert.equal(files.size, 3);
  });

  it('publishes a subdirectory rooted at `dir`, not the whole sandbox', async () => {
    const { sandbox } = fakeSandbox({
      'apps/todo/server.js': 'todo app',
      'apps/todo/data.json': '{}',
      'apps/other/server.js': 'other app',
    });
    const files = await collectTree(sandbox, 'apps/todo', 'app');
    assert.deepEqual(Array.from(files.keys()).sort(), ['data.json', 'server.js']);
    assert.equal(files.get('server.js'), 'todo app');
  });

  it('only ever calls list()/read() — never touches a raw filesystem path', async () => {
    const { sandbox, calls } = fakeSandbox({ 'a/b.js': 'x' });
    await collectTree(sandbox, '.', 'app');
    assert.ok(calls.every((c) => c.startsWith('list:') || c.startsWith('read:')));
    assert.ok(calls.includes('list:.'));
    assert.ok(calls.includes('list:a'));
    assert.ok(calls.includes('read:a/b.js'));
  });

  it('throws PublishTreeTooLargeError instead of silently truncating when maxFiles is exceeded', async () => {
    const { sandbox } = fakeSandbox({ 'a.js': '1', 'b.js': '2', 'c.js': '3' });
    await assert.rejects(
      () => collectTree(sandbox, '.', 'app', { maxFiles: 2 }),
      PublishTreeTooLargeError,
    );
  });

  it('an empty/missing directory publishes zero files rather than throwing', async () => {
    const { sandbox } = fakeSandbox({});
    const files = await collectTree(sandbox, 'does/not/exist', 'app');
    assert.equal(files.size, 0);
  });
});
