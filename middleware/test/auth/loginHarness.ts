/**
 * Shared harness for the password sign-in route tests (loginRoute.test.ts,
 * loginLockoutDos.test.ts): the real auth router over express.json() +
 * cookieParser(), driven with `invoke` (no listening socket), and a fresh
 * limiter per harness. Every harness builds its own limiter on purpose: the
 * suite runs files concurrently and every `invoke` request shares the client
 * key 'unknown' unless it sets a socket address, so a shared limiter would
 * leak budget between cases.
 */

import { strict as assert } from 'node:assert';

import cookieParser from 'cookie-parser';
import express, { type Express } from 'express';

import type { AuditEntryInput } from '../../src/auth/adminAuditLog.js';
import type { ClientAddressPolicy } from '../../src/auth/clientAddress.js';
import { LOGIN_DEVICE_COOKIE } from '../../src/auth/loginDeviceCookie.js';
import {
  createLoginRateLimiter,
  DEFAULT_LOGIN_LIMITER_CONFIG,
  type LoginLimiterConfig,
  type LoginRateLimiter,
} from '../../src/auth/loginRateLimiter.js';
import { hashPassword } from '../../src/auth/passwordHasher.js';
import type { AuthResult, PasswordProvider } from '../../src/auth/providers/AuthProvider.js';
import {
  LOCAL_PROVIDER_ID,
  LocalPasswordProvider,
} from '../../src/auth/providers/LocalPasswordProvider.js';
import { ProviderRegistry } from '../../src/auth/providerRegistry.js';
import type {
  CreateFirstAdminInput,
  FirstAdminResult,
  UserRecord,
  UserStore,
} from '../../src/auth/userStore.js';
import { createAuthRouter } from '../../src/routes/auth.js';
import { invoke, type InvokeResult } from '../_helpers/httpInvoke.js';

export const SIGNING_KEY = new TextEncoder().encode('login-route-test-signing-key-'.repeat(3));
export const ADMIN = 'admin@example.com';
export const PASSWORD = 'correct horse battery staple';
export const SECOND = 1000;

// ─── test doubles ──────────────────────────────────────────────────────────

function userRecord(email: string, displayName: string): UserRecord {
  const now = new Date();
  return {
    id: `mock-${email}`,
    email,
    provider: LOCAL_PROVIDER_ID,
    providerUserId: email.toLowerCase(),
    displayName,
    role: 'admin',
    status: 'active',
    createdAt: now,
    updatedAt: now,
    lastLoginAt: null,
  };
}

export class InMemoryUserStore {
  rows = new Map<string, UserRecord & { passwordHash: string }>();

  async addLocalUser(email: string, plainPassword: string): Promise<void> {
    const passwordHash = await hashPassword(plainPassword);
    this.rows.set(email.toLowerCase(), { ...userRecord(email, email), passwordHash });
  }

  async findByEmailWithHash(provider: string, email: string): Promise<UserRecord | null> {
    if (provider !== LOCAL_PROVIDER_ID) return null;
    return this.rows.get(email.toLowerCase()) ?? null;
  }

  async markLoginNow(_id: string): Promise<void> {
    /* fire-and-forget in the provider */
  }

  async count(): Promise<number> {
    return this.rows.size;
  }

  async createFirstAdmin(input: CreateFirstAdminInput): Promise<FirstAdminResult> {
    if (this.rows.size > 0) return { outcome: 'not_empty', totalUsers: this.rows.size };
    const user = userRecord(input.email, input.displayName);
    this.rows.set(input.email.toLowerCase(), { ...user, passwordHash: input.passwordHash });
    return { outcome: 'created', user };
  }
}

export class FakeClock {
  t = 1_800_000_000_000;
  now = (): number => this.t;
}

/** Counts `verify` calls — the argon2 work a refusal must never reach. */
function spyOnVerify(provider: PasswordProvider): { calls: number } {
  const counter = { calls: 0 };
  const original = provider.verify.bind(provider);
  provider.verify = async (body: unknown): Promise<AuthResult> => {
    counter.calls += 1;
    return original(body);
  };
  return counter;
}

export interface Harness {
  app: Express;
  store: InMemoryUserStore;
  provider: PasswordProvider;
  verifies: { calls: number };
  limiter: LoginRateLimiter;
  clock: FakeClock;
  audit: AuditEntryInput[];
}

export interface HarnessOptions {
  config?: Partial<LoginLimiterConfig>;
  clientAddress?: ClientAddressPolicy;
  /** `AUTH_LOGIN_IPV6_PREFIX`; the router's default (/64) when absent. */
  ipv6PrefixBits?: number;
  /** Build the router WITHOUT a `loginLimiter` dep (the always-on default). */
  unwired?: boolean;
  provider?: PasswordProvider;
  emptyStore?: boolean;
}

export async function harness(opts: HarnessOptions = {}): Promise<Harness> {
  const store = new InMemoryUserStore();
  if (!opts.emptyStore) await store.addLocalUser(ADMIN, PASSWORD);
  const provider = opts.provider ?? new LocalPasswordProvider(store as unknown as UserStore);
  const verifies = spyOnVerify(provider);
  const registry = new ProviderRegistry();
  registry.replaceActive([provider]);
  const clock = new FakeClock();
  const limiter = createLoginRateLimiter(
    { ...DEFAULT_LOGIN_LIMITER_CONFIG, ...opts.config },
    clock.now,
  );
  const audit: AuditEntryInput[] = [];

  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(
    '/api/v1/auth',
    createAuthRouter({
      registry,
      userStore: store as unknown as UserStore,
      signingKey: SIGNING_KEY,
      publicBaseUrl: 'https://omadia.example',
      defaultReturnPath: '/',
      setupAllowed: opts.emptyStore === true,
      ...(opts.unwired
        ? {}
        : {
            loginLimiter: {
              limiter,
              clientAddress: opts.clientAddress ?? { kind: 'socket' },
              ...(opts.ipv6PrefixBits !== undefined ? { ipv6PrefixBits: opts.ipv6PrefixBits } : {}),
              audit: {
                record: async (entry: AuditEntryInput) => {
                  audit.push(entry);
                },
              },
            },
          }),
    }),
  );
  return { app, store, provider, verifies, limiter, clock, audit };
}

export interface RequestExtras {
  headers?: Record<string, string>;
  remoteAddress?: string;
}

export function login(h: Harness, body: unknown, extra: RequestExtras = {}): Promise<InvokeResult> {
  return invoke(h.app, 'POST', `/api/v1/auth/login/${LOCAL_PROVIDER_ID}`, {
    json: body,
    ...(extra.headers ? { headers: extra.headers } : {}),
    ...(extra.remoteAddress ? { remoteAddress: extra.remoteAddress } : {}),
  });
}

export const wrong = (email = ADMIN): unknown => ({ email, password: 'not the password' });
export const right = (email = ADMIN, password = PASSWORD): unknown => ({ email, password });

/** Let the event loop run until `cond` holds (request bodies parse asynchronously). */
export async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i += 1) {
    await new Promise((r) => setImmediate(r));
  }
  assert.ok(cond(), 'condition never became true');
}

export function json(res: InvokeResult): Record<string, unknown> {
  return JSON.parse(res.text) as Record<string, unknown>;
}

export function setCookies(res: InvokeResult): string[] {
  const raw = res.headers['set-cookie'];
  if (raw === undefined) return [];
  return Array.isArray(raw) ? raw.map(String) : [String(raw)];
}

/** The device cookie a response sets, as a `name=value` pair for a `cookie` header. */
export function deviceCookieFrom(res: InvokeResult): string {
  const cookie = setCookies(res).find((c) => c.startsWith(`${LOGIN_DEVICE_COOKIE}=`));
  assert.ok(cookie, 'the response sets the device cookie');
  return cookie.split(';')[0] ?? '';
}

export function assertRateLimited(res: InvokeResult): void {
  assert.equal(res.status, 429);
  const body = json(res);
  assert.equal(body['code'], 'auth.rate_limited');
  assert.equal(typeof body['retry_after_s'], 'number');
  assert.equal(res.headers['retry-after'], String(body['retry_after_s']));
  assert.deepEqual(setCookies(res), [], 'a refusal never sets a cookie');
}

export function assertBusy(res: InvokeResult): void {
  assert.equal(res.status, 503);
  assert.equal(json(res)['code'], 'auth.busy');
  assert.ok(Number(res.headers['retry-after']) >= 1);
  assert.deepEqual(setCookies(res), [], 'a refusal never sets a cookie');
}
