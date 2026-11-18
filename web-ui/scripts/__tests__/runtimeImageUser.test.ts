import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The published web-ui image must not run `node server.js` as root.
 *
 * The middleware image drops privileges in its entrypoint (gosu) because it
 * has to chown a mounted volume first. The web-ui mounts nothing and listens
 * on an unprivileged port, so a plain `USER` in the runtime stage is enough,
 * and it is easy to lose in an edit that reorders the stage. This pins it
 * before merge; the release pipeline pushes multi-arch images without loading
 * them, so nothing there could inspect the built image in time.
 *
 * It lives under `scripts/` because vitest only collects `app/` and
 * `scripts/`, and the Dockerfile is build tooling, not app code.
 */

const DOCKERFILE = path.resolve(__dirname, '../../Dockerfile');

interface Instruction {
  readonly keyword: string;
  readonly args: string;
}

/** Instructions of the LAST stage — the one the image actually runs. */
function runtimeStage(dockerfile: string): readonly Instruction[] {
  const instructions = dockerfile
    .replace(/\\\r?\n/g, ' ')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .map((line) => {
      const [keyword = '', ...rest] = line.split(/\s+/);
      return { keyword: keyword.toUpperCase(), args: rest.join(' ') };
    });
  const lastFrom = instructions.map((i) => i.keyword).lastIndexOf('FROM');
  return instructions.slice(lastFrom);
}

describe('web-ui Dockerfile runtime stage', () => {
  const stage = runtimeStage(readFileSync(DOCKERFILE, 'utf-8'));
  const startIndex = stage.findIndex((i) => i.keyword === 'CMD' || i.keyword === 'ENTRYPOINT');
  const usersBeforeStart = stage.slice(0, startIndex).filter((i) => i.keyword === 'USER');
  const effectiveUser = usersBeforeStart.at(-1)?.args.split(':')[0] ?? '';

  it('starts the server as a non-root user', () => {
    expect(startIndex).toBeGreaterThan(0);
    expect(effectiveUser).not.toBe('');
    expect(['root', '0']).not.toContain(effectiveUser);
  });

  it('hands every copied file to that user, so .next stays writable at runtime', () => {
    const copies = stage.filter((i) => i.keyword === 'COPY');
    expect(copies.length).toBeGreaterThan(0);
    for (const copy of copies) {
      expect(copy.args, copy.args).toContain(`--chown=${effectiveUser}:${effectiveUser}`);
    }
  });
});
