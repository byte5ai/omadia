/**
 * GitHub OAuth via the **Device Authorization Grant** for the in-app
 * "Create Issue" button.
 *
 * Why device flow: omadia is shipped (public OSS + Docker + desktop), so
 * we cannot bundle a client_secret — any distributed secret is readable
 * and GitHub treats a leaked OAuth secret as compromised. The device flow
 * needs ONLY the public `client_id` (safe to hard-wire), so omadia can
 * ship "batteries included" with byte5's OAuth App baked in. Same pattern
 * the GitHub CLI uses.
 *
 * Flow: requestDeviceCode() -> show user_code + verification_uri to the
 * operator -> poll pollAccessToken(device_code) until authorized. Scope
 * `public_repo` is enough to open issues on byte5ai/omadia. Tokens are
 * non-expiring (classic OAuth App), so there is no refresh path.
 */

/**
 * Public OAuth-App client id baked into the shipped product. The client
 * id is NOT a secret — only the (here unused) client secret would be.
 * Replace this with byte5's registered OAuth App client id and enable
 * "Device flow" on that app. While it carries the REPLACE_ marker the
 * feature reports itself as unconfigured.
 */
export const DEFAULT_GITHUB_CLIENT_ID = 'Ov23liPaKg7r70n0ue4L';

export const GITHUB_PROVIDER_ID = 'github';

/** Minimum scope to open issues on the public repo. */
export const GITHUB_ISSUE_SCOPES = ['public_repo'] as const;

const DEVICE_CODE_ENDPOINT = 'https://github.com/login/device/code';
const TOKEN_ENDPOINT = 'https://github.com/login/oauth/access_token';
const USER_ENDPOINT = 'https://api.github.com/user';
const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';
const USER_AGENT = 'omadia-issue-button';

export interface DeviceCodeRequest {
  /** Server-only secret half — used to poll, never sent to the browser. */
  deviceCode: string;
  /** Short code the operator types on the verification page. */
  userCode: string;
  /** Page the operator opens (https://github.com/login/device). */
  verificationUri: string;
  /** Seconds until the code expires. */
  expiresIn: number;
  /** Minimum seconds between polls. */
  interval: number;
}

export type DevicePollResult =
  | { status: 'authorized'; accessToken: string; scope: string }
  | { status: 'pending' }
  | { status: 'slow_down'; interval: number }
  | { status: 'expired' }
  | { status: 'denied' }
  | { status: 'error'; error: string };

interface RawDeviceCodeResponse {
  device_code?: unknown;
  user_code?: unknown;
  verification_uri?: unknown;
  expires_in?: unknown;
  interval?: unknown;
}

interface RawTokenResponse {
  access_token?: unknown;
  scope?: unknown;
  error?: unknown;
  interval?: unknown;
}

export class GitHubDeviceFlowProvider {
  readonly id = GITHUB_PROVIDER_ID;
  readonly displayName = 'GitHub';

  constructor(
    private readonly clientId: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async requestDeviceCode(
    scopes: readonly string[],
  ): Promise<DeviceCodeRequest> {
    const res = await this.fetchImpl(DEVICE_CODE_ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: new URLSearchParams({
        client_id: this.clientId,
        scope: scopes.join(' '),
      }).toString(),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`github device-code endpoint ${res.status}`);
    }
    let parsed: RawDeviceCodeResponse;
    try {
      parsed = JSON.parse(text) as RawDeviceCodeResponse;
    } catch {
      throw new Error('github device-code endpoint returned non-JSON');
    }
    const deviceCode =
      typeof parsed.device_code === 'string' ? parsed.device_code : '';
    const userCode =
      typeof parsed.user_code === 'string' ? parsed.user_code : '';
    const verificationUri =
      typeof parsed.verification_uri === 'string'
        ? parsed.verification_uri
        : 'https://github.com/login/device';
    const expiresIn =
      typeof parsed.expires_in === 'number' ? parsed.expires_in : 900;
    const interval =
      typeof parsed.interval === 'number' ? parsed.interval : 5;
    if (!deviceCode || !userCode) {
      throw new Error('github device-code response missing fields');
    }
    return { deviceCode, userCode, verificationUri, expiresIn, interval };
  }

  async pollAccessToken(deviceCode: string): Promise<DevicePollResult> {
    let res: Awaited<ReturnType<typeof fetch>>;
    try {
      res = await this.fetchImpl(TOKEN_ENDPOINT, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: new URLSearchParams({
          client_id: this.clientId,
          device_code: deviceCode,
          grant_type: DEVICE_GRANT_TYPE,
        }).toString(),
      });
    } catch {
      return { status: 'error', error: 'network' };
    }
    const text = await res.text();
    let parsed: RawTokenResponse;
    try {
      parsed = JSON.parse(text) as RawTokenResponse;
    } catch {
      return { status: 'error', error: 'non_json' };
    }
    if (typeof parsed.access_token === 'string' && parsed.access_token) {
      return {
        status: 'authorized',
        accessToken: parsed.access_token,
        scope: typeof parsed.scope === 'string' ? parsed.scope : '',
      };
    }
    const error = typeof parsed.error === 'string' ? parsed.error : 'unknown';
    switch (error) {
      case 'authorization_pending':
        return { status: 'pending' };
      case 'slow_down':
        return {
          status: 'slow_down',
          interval: typeof parsed.interval === 'number' ? parsed.interval : 10,
        };
      case 'expired_token':
        return { status: 'expired' };
      case 'access_denied':
        return { status: 'denied' };
      default:
        return { status: 'error', error };
    }
  }

  /** Resolve the authenticated user's GitHub login for display.
   *  Best-effort — callers treat a throw / empty string as "unknown". */
  async fetchUserLogin(accessToken: string): Promise<string> {
    const res = await this.fetchImpl(USER_ENDPOINT, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': USER_AGENT,
      },
    });
    if (!res.ok) {
      throw new Error(`github user endpoint ${res.status}`);
    }
    const payload = (await res.json()) as { login?: unknown };
    return typeof payload.login === 'string' ? payload.login : '';
  }
}

/** Build a device-flow provider from the (optional) env override, falling
 *  back to the baked-in client id. Returns `null` when no real client id
 *  is configured yet (still the REPLACE_ placeholder) so the route layer
 *  reports the feature as unconfigured instead of failing mid-flow. */
export function createGitHubDeviceProvider(
  envClientId?: string,
  fetchImpl: typeof fetch = fetch,
): GitHubDeviceFlowProvider | null {
  const clientId = envClientId || DEFAULT_GITHUB_CLIENT_ID;
  if (!clientId || clientId.startsWith('REPLACE_')) return null;
  return new GitHubDeviceFlowProvider(clientId, fetchImpl);
}
