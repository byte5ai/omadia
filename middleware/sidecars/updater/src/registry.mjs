/**
 * "Does this tag exist?" against an OCI registry (#696).
 *
 * The Docker engine gets this property for free: it pulls every image before
 * stopping anything, so a typo'd tag or a registry outage is discovered while
 * the old stack is still fully up. On Fly there is no pull step we control —
 * the platform fetches the image as part of updating the Machine — so without
 * this check a bad tag would only surface *after* the first Machine has been
 * told to move, which is exactly the failure mode the ordering exists to
 * prevent.
 *
 * Implements the standard registry-v2 auth dance: try anonymously, and if the
 * registry answers 401 with a `WWW-Authenticate: Bearer realm=…` challenge,
 * fetch a token from that realm and retry. That is what makes it work against
 * GHCR's public images without credentials, and against a private registry if
 * one is ever configured.
 */

const MANIFEST_ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

/**
 * Split `ghcr.io/byte5ai/omadia-middleware` into host + repository. A ref with
 * no registry host (`postgres`) is Docker Hub's `library/` namespace.
 *
 * @param {string} repoRef
 * @returns {{ host: string, repository: string }}
 */
export function splitRepoRef(repoRef) {
  const [maybeHost, ...rest] = repoRef.split('/');
  const looksLikeHost =
    rest.length > 0 && (maybeHost.includes('.') || maybeHost.includes(':') || maybeHost === 'localhost');
  if (!looksLikeHost) {
    return {
      host: 'registry-1.docker.io',
      repository: repoRef.includes('/') ? repoRef : `library/${repoRef}`,
    };
  }
  return { host: maybeHost, repository: rest.join('/') };
}

/** Parse a `Bearer realm="…",service="…",scope="…"` challenge into its parts. */
export function parseChallenge(header) {
  if (typeof header !== 'string' || !/^Bearer /i.test(header)) return null;
  const params = {};
  for (const match of header.slice(7).matchAll(/([a-zA-Z_]+)="([^"]*)"/g)) {
    params[match[1]] = match[2];
  }
  return params.realm ? params : null;
}

/**
 * @param {string} repoRef  e.g. `ghcr.io/byte5ai/omadia-middleware`
 * @param {string} tag
 * @param {{ fetchImpl?: typeof fetch, timeoutMs?: number }} [opts]
 * @returns {Promise<{ exists: boolean, reason?: string }>}
 */
export async function manifestExists(repoRef, tag, opts = {}) {
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const { host, repository } = splitRepoRef(repoRef);
  const url = `https://${host}/v2/${repository}/manifests/${encodeURIComponent(tag)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => { controller.abort(); }, timeoutMs);
  try {
    const head = async (token) =>
      doFetch(url, {
        method: 'HEAD',
        headers: {
          accept: MANIFEST_ACCEPT,
          ...(token !== undefined ? { authorization: `Bearer ${token}` } : {}),
        },
        signal: controller.signal,
      });

    let res = await head(undefined);
    if (res.status === 401) {
      const challenge = parseChallenge(res.headers.get('www-authenticate'));
      if (challenge === null) {
        return { exists: false, reason: 'registry_auth_challenge_unparseable' };
      }
      const tokenUrl = new URL(challenge.realm);
      if (challenge.service) tokenUrl.searchParams.set('service', challenge.service);
      tokenUrl.searchParams.set('scope', challenge.scope ?? `repository:${repository}:pull`);
      const tokenRes = await doFetch(tokenUrl.toString(), { signal: controller.signal });
      if (!tokenRes.ok) {
        return { exists: false, reason: `registry_token_${tokenRes.status}` };
      }
      const body = await tokenRes.json();
      const token = body?.token ?? body?.access_token;
      if (typeof token !== 'string') {
        return { exists: false, reason: 'registry_token_missing' };
      }
      res = await head(token);
    }

    if (res.status === 404) return { exists: false, reason: 'tag_not_found' };
    if (!res.ok) return { exists: false, reason: `registry_status_${res.status}` };
    return { exists: true };
  } catch (err) {
    // Unreachable registry is NOT "tag missing" — say which it was, so the
    // operator is not sent looking for a typo in a correct tag.
    return {
      exists: false,
      reason: `registry_unreachable: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}
