/**
 * Issue #667 — an error message must not assert a cause the client never checked.
 *
 * `errorMiddlewareUnreachable` was shown for ANY HTTP 500 with an HTML body and
 * claimed two things it had not verified: that the middleware was unreachable
 * (a 500 means something *answered*), and that the deployment was a local dev
 * setup (`localhost:3979`, `npm run dev`). In #665 the middleware was up and
 * serving — its pg pool was dead — and this string sent the investigation at
 * `MIDDLEWARE_URL` while the real fault was a plugin's pool lifetime. That is
 * worse than an unhelpful error: it points at a healthy component, on an
 * address that does not exist in the deployment being debugged.
 *
 * These are catalogue-level guards rather than component tests on purpose. The
 * defect was never in the rendering — it was in the *words*, in both locales, at
 * two call sites. A guard on the words is the one that keeps holding when a
 * third call site appears.
 */

import { describe, expect, it } from 'vitest';

import de from '../../messages/de.json';
import en from '../../messages/en.json';

type Catalog = Record<string, unknown>;

function flatten(obj: Catalog, prefix = ''): Array<[string, string]> {
  return Object.entries(obj).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      return flatten(value as Catalog, path);
    }
    return typeof value === 'string' ? [[path, value] as [string, string]] : [];
  });
}

const LOCALES: Array<[string, Catalog]> = [
  ['en', en as Catalog],
  ['de', de as Catalog],
];

describe('#667 — no user-facing string names a dev-only endpoint', () => {
  /**
   * The generalised form of the bug. The original string hardcoded
   * `localhost:3979`, which is meaningless — and actively misleading — on a
   * hosted instance. Guarding the whole catalogue rather than the one key means
   * the next copy that reaches for a dev address fails here instead of in
   * someone's incident.
   */
  it.each(LOCALES)('%s carries no localhost/dev-port literal', (_name, catalog) => {
    const offenders = flatten(catalog).filter(([, value]) =>
      /localhost:\d+|127\.0\.0\.1:\d+|npm run dev/i.test(value),
    );
    expect(offenders).toEqual([]);
  });

  it.each(LOCALES)('%s no longer ships the retired errorMiddlewareUnreachable key', (_name, catalog) => {
    const keys = flatten(catalog).map(([key]) => key);
    expect(keys.filter((k) => k.endsWith('errorMiddlewareUnreachable'))).toEqual([]);
  });
});

describe('#667 — the replacement says only what is known', () => {
  it.each(LOCALES)('%s does not assert unreachability', (_name, catalog) => {
    const map = new Map(flatten(catalog));
    for (const key of ['chat.errorUpstreamErrorPage', 'memory.errorUpstreamErrorPage']) {
      const value = map.get(key);
      expect(value, `${key} missing`).toBeTruthy();
      // "unreachable"/"nicht erreichbar" is precisely the claim the client
      // cannot make: the request WAS answered, with a 500.
      expect(value).not.toMatch(/unreachable|nicht erreichbar/i);
      // It must still name the observable fact, or it is merely vague rather
      // than wrong — which would be a different failure, not a fix.
      expect(value).toMatch(/500/);
    }
  });
});

describe('#641 — the correlation reference is available to render', () => {
  it.each(LOCALES)('%s has errorCorrelationRef with an {id} placeholder', (_name, catalog) => {
    const value = new Map(flatten(catalog)).get('chat.errorCorrelationRef');
    expect(value, 'chat.errorCorrelationRef missing').toBeTruthy();
    // Without the placeholder the token never reaches the user, which is the
    // entire point of #641.
    expect(value).toContain('{id}');
  });
});
