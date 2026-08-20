import path from 'node:path';

/**
 * Traversal-hardening for `Sandbox.read/write/list`, same discipline as the
 * #772 broker and `zipExtractor.ts`'s zip-slip guard: a relative path is
 * clamped against a fixed root and any resolution that would escape it is
 * rejected — never silently re-rooted.
 *
 * Deliberately conservative: an ABSOLUTE incoming path is rejected outright
 * rather than treated as root-relative (a caller who means "the sandbox's
 * own root" should pass `.` or `''`), and a NUL byte anywhere in the input
 * is rejected outright (some backends would otherwise truncate the string at
 * the OS boundary and the .. rejection would already have run against the
 * un-truncated string, or vice versa — reject rather than reason about it).
 */
export type PathGuardOutcome =
  | { readonly ok: true; readonly relativePath: string; readonly absolutePath: string }
  | { readonly ok: false; readonly reason: 'empty' | 'absolute' | 'null_byte' | 'escape' };

export function clampSandboxPath(root: string, requested: string): PathGuardOutcome {
  if (requested.includes('\0')) return { ok: false, reason: 'null_byte' };

  const trimmed = requested.trim();
  if (trimmed.length === 0) return { ok: false, reason: 'empty' };

  // Reject POSIX and Windows absolute forms outright — a sandbox path is
  // always root-relative, never an escape hatch to "wherever you point it".
  if (path.posix.isAbsolute(trimmed) || /^[a-zA-Z]:[\\/]/.test(trimmed) || trimmed.startsWith('\\')) {
    return { ok: false, reason: 'absolute' };
  }

  const normalizedRoot = path.resolve(root);
  const candidate = path.resolve(normalizedRoot, trimmed);
  const withinRoot =
    candidate === normalizedRoot || candidate.startsWith(normalizedRoot + path.sep);
  if (!withinRoot) return { ok: false, reason: 'escape' };

  return {
    ok: true,
    relativePath: path.relative(normalizedRoot, candidate),
    absolutePath: candidate,
  };
}

/**
 * Same clamp, but against a POSIX in-container root (the host's `path`
 * module is platform-dependent; sandbox paths are always POSIX because
 * every backend today runs a Linux container/VM). Used by
 * `DockerSandboxBackend` so the guard is correct on a Windows or macOS
 * development host too.
 */
export function clampSandboxPathPosix(root: string, requested: string): PathGuardOutcome {
  if (requested.includes('\0')) return { ok: false, reason: 'null_byte' };

  const trimmed = requested.trim();
  if (trimmed.length === 0) return { ok: false, reason: 'empty' };
  if (path.posix.isAbsolute(trimmed)) return { ok: false, reason: 'absolute' };

  const normalizedRoot = path.posix.resolve(root);
  const candidate = path.posix.resolve(normalizedRoot, trimmed);
  const withinRoot =
    candidate === normalizedRoot || candidate.startsWith(normalizedRoot + '/');
  if (!withinRoot) return { ok: false, reason: 'escape' };

  return {
    ok: true,
    relativePath: path.posix.relative(normalizedRoot, candidate),
    absolutePath: candidate,
  };
}
