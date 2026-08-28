/**
 * Persist the chosen version into the compose project's root `.env` (#432).
 *
 * Without this step the update is silently temporary: compose interpolates
 * `${OMADIA_VERSION:-latest}` from the shell or the root `.env` at `up` time,
 * so the operator's next routine `docker compose up -d` would recreate the
 * stack on `latest` and quietly undo the pinned version they chose. The
 * acceptance criterion "the pinned version survives a subsequent manual
 * docker compose up -d" is entirely this file.
 *
 * The file is bind-mounted as a SINGLE file, so it must be rewritten in place —
 * the usual write-temp-then-rename dance would replace the inode and break the
 * mount, leaving the container writing to a file the host no longer sees.
 */

import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';

const KEY = 'OMADIA_VERSION';

/**
 * Insert or replace `OMADIA_VERSION=<value>` in a dotenv document, preserving
 * every other line, comment and ordering.
 *
 * @param {string} content
 * @param {string} value
 * @returns {string}
 */
export function upsertVersion(content, value) {
  const line = `${KEY}=${value}`;
  const lines = content.split('\n');
  let replaced = false;

  const next = lines.map((raw) => {
    // Only a real assignment counts — a commented-out `#OMADIA_VERSION=…` is
    // documentation and must survive untouched.
    if (/^\s*OMADIA_VERSION\s*=/.test(raw)) {
      if (replaced) return raw;
      replaced = true;
      return line;
    }
    return raw;
  });

  if (replaced) return next.join('\n');

  // Append, keeping exactly one trailing newline regardless of how the
  // operator's file ended.
  const body = content.replace(/\n+$/, '');
  return body.length === 0 ? `${line}\n` : `${body}\n${line}\n`;
}

/** Read the currently pinned value, or null when unset. @param {string} content */
export function readVersion(content) {
  for (const raw of content.split('\n')) {
    const match = /^\s*OMADIA_VERSION\s*=\s*(.*)$/.exec(raw);
    if (match) return (match[1] ?? '').trim();
  }
  return null;
}

/**
 * Boot-time check that the pin target is usable.
 *
 * The overlay bind-mounts a SINGLE file (`./.env:/workspace/.env`). If the
 * operator skipped `touch .env`, Docker silently creates a DIRECTORY at the
 * source and mounts that — and the failure would otherwise surface only in the
 * middle of an update, after images have been pulled. It is also the point
 * where a uid mismatch on a Linux host shows up, which is the other way this
 * mount goes wrong.
 *
 * @param {string} path
 * @param {typeof fs} [fsImpl]
 * @returns {Promise<void>} rejects with an actionable message
 */
export async function assertEnvFileUsable(path, fsImpl = fs) {
  let stat;
  try {
    stat = await fsImpl.stat(path);
  } catch {
    throw new Error(
      `${path} does not exist — create the compose project's .env first (\`touch .env\`); Docker creates a DIRECTORY for a missing single-file bind source`,
    );
  }
  if (stat.isDirectory()) {
    throw new Error(
      `${path} is a directory, not a file — Docker created it because .env was missing when the stack came up. Remove it, run \`touch .env\`, and recreate the updater container`,
    );
  }
  try {
    await fsImpl.access(path, fsConstants.W_OK);
  } catch {
    throw new Error(
      `${path} is not writable by this container — set UPDATER_UID/UPDATER_GID to the owner of the file on the host`,
    );
  }
}

/**
 * @param {string} path
 * @param {string} value
 * @returns {Promise<{ previous: string | null }>}
 */
export async function pinVersion(path, value) {
  const content = await fs.readFile(path, 'utf8');
  const previous = readVersion(content);
  await fs.writeFile(path, upsertVersion(content, value), 'utf8');
  return { previous };
}

/**
 * Restore a previous pin during rollback. A `null` previous means the key was
 * absent before this update, so the line is removed rather than set to an
 * empty value — `OMADIA_VERSION=` would make compose resolve the image tag to
 * the empty string instead of falling back to `latest`.
 *
 * @param {string} path
 * @param {string | null} previous
 */
export async function restoreVersion(path, previous) {
  const content = await fs.readFile(path, 'utf8');
  if (previous === null) {
    const cleaned = content
      .split('\n')
      .filter((raw) => !/^\s*OMADIA_VERSION\s*=/.test(raw))
      .join('\n');
    await fs.writeFile(path, cleaned, 'utf8');
    return;
  }
  await fs.writeFile(path, upsertVersion(content, previous), 'utf8');
}
