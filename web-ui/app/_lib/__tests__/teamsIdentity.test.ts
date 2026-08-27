import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  TEAMS_BOT_SECRET_REF_PREFIX,
  TEAMS_PROVISIONING_STATES,
  formatTeamsBotsConfig,
  isTeamsBotSecretRef,
  parseTeamsIdentityEnvelope,
  teamsBotConfigMessages,
  teamsProvisioningProgress,
  teamsProvisioningStateMessage,
  teamsProvisioningTone,
  type LocalizedMessage,
  type TeamsBotConfigEntry,
} from '../teamsIdentity';
import {
  ENTRA_ADMIN_CONSENT_DOCS_URL,
  classifyTeamsIdentityError,
  teamsIdentityErrorLink,
  teamsIdentityErrorMessages,
  teamsIdentityErrorTechnicalDetail,
} from '../teamsIdentityErrors';

/**
 * #860 / W2a — the operator screen must be able to say, in the operator's own
 * language, what the Teams provisioning run did and what to do about it.
 *
 * Three classes of assertion live here, and the middle one is the reason this
 * file reads middleware sources at all:
 *
 *   1. the classifier turns the persisted `last_error` sentence into a code
 *      plus its captured arguments;
 *   2. the sentences it parses are the sentences the runner actually WRITES,
 *      and the state vocabulary is the one the store actually persists — both
 *      read out of the middleware, so a reworded producer fails here instead
 *      of silently degrading the UI in production;
 *   3. every i18n key these modules emit exists in BOTH locales, so nothing
 *      they produce can reach a screen as a bare key.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..');
const MESSAGES_DIR = path.resolve(HERE, '..', '..', '..', 'messages');

function readMiddleware(...segments: string[]): string {
  return fs.readFileSync(path.resolve(REPO_ROOT, 'middleware', ...segments), 'utf8');
}

/** The two sentences the job runner persists, reproduced verbatim. */
const CONSENT_MISSING_RAW =
  'consent_missing: admin consent required for scopes [Application.ReadWrite.All, AppCatalog.ReadWrite.All] — grant them in the customer tenant, then re-run provisioning';
const ARM_NOT_CONFIGURED_RAW =
  'arm_not_configured: bot creation needs the ARM setup fields [azure_subscription_id, azure_resource_group] on the M365 connector — configure them, then re-run provisioning (the app registration is kept)';
/** The throttle path writes the CONNECTOR's message plus the give-up suffix. */
const THROTTLED_RAW = '429 from Graph (gave up after 3 attempts)';

// ---------------------------------------------------------------------------
// classifyTeamsIdentityError
// ---------------------------------------------------------------------------

describe('classifyTeamsIdentityError', () => {
  it('returns null when there is no error (the normal case)', () => {
    expect(classifyTeamsIdentityError(null)).toBeNull();
    expect(classifyTeamsIdentityError(undefined)).toBeNull();
    expect(classifyTeamsIdentityError('   ')).toBeNull();
  });

  it('names the missing scopes of a ConsentMissing failure', () => {
    const detail = classifyTeamsIdentityError(CONSENT_MISSING_RAW);
    expect(detail).not.toBeNull();
    expect(detail?.code).toBe('consent_missing');
    expect(detail?.scopes).toEqual([
      'Application.ReadWrite.All',
      'AppCatalog.ReadWrite.All',
    ]);
    // TERMINAL — an admin has to act; re-running alone changes nothing.
    expect(detail?.retryable).toBe(false);
    expect(detail?.raw).toBe(CONSENT_MISSING_RAW);
  });

  it('names the missing setup fields of an ArmNotConfigured halt', () => {
    const detail = classifyTeamsIdentityError(ARM_NOT_CONFIGURED_RAW);
    expect(detail?.code).toBe('arm_not_configured');
    expect(detail?.fields).toEqual(['azure_subscription_id', 'azure_resource_group']);
    expect(detail?.retryable).toBe(false);
  });

  it('survives an empty bracketed list (the runner writes [] for no names)', () => {
    // `missingScopesOf` returns [] when the connector error carried no list;
    // the copy then has to work WITHOUT naming anything.
    const detail = classifyTeamsIdentityError(
      'consent_missing: admin consent required for scopes [] — grant them in the customer tenant, then re-run provisioning',
    );
    expect(detail?.code).toBe('consent_missing');
    expect(detail?.scopes).toEqual([]);
  });

  it('matches the prefix, not the prose around it', () => {
    // The wording between the prefix and the list is NOT a contract. Only a
    // reworded prefix or a vanished list should ever break this parser.
    const detail = classifyTeamsIdentityError(
      'consent_missing: totally different wording [Group.Read.All] and more',
    );
    expect(detail?.code).toBe('consent_missing');
    expect(detail?.scopes).toEqual(['Group.Read.All']);
  });

  it('reads a throttle as retryable', () => {
    const detail = classifyTeamsIdentityError(THROTTLED_RAW);
    expect(detail?.code).toBe('throttled');
    expect(detail?.retryable).toBe(true);
    expect(detail?.retryAfterSeconds).toBeUndefined();
  });

  it('captures the Retry-After hint when the sentence carries one', () => {
    expect(
      classifyTeamsIdentityError('Graph throttled the request, Retry-After: 42')
        ?.retryAfterSeconds,
    ).toBe(42);
    expect(
      classifyTeamsIdentityError('rate limit hit — retry after 7 seconds')
        ?.retryAfterSeconds,
    ).toBe(7);
  });

  it('falls back to unknown without pretending to understand', () => {
    const detail = classifyTeamsIdentityError('ENOTFOUND graph.microsoft.com');
    expect(detail?.code).toBe('unknown');
    expect(detail?.retryable).toBe(false);
    expect(detail?.raw).toBe('ENOTFOUND graph.microsoft.com');
  });

  it('does not mistake a consent failure for a throttle', () => {
    // The prefixes are checked first on purpose — a consent sentence that
    // happened to mention 429 must still route to the actionable copy.
    const detail = classifyTeamsIdentityError(
      'consent_missing: admin consent required for scopes [X] after 429 retries',
    );
    expect(detail?.code).toBe('consent_missing');
  });
});

// ---------------------------------------------------------------------------
// The producer contract — read out of the middleware, not assumed
// ---------------------------------------------------------------------------

describe('the classified sentences are the ones the middleware writes', () => {
  const job = readMiddleware('src', 'services', 'teamsProvisioningJob.ts');

  it('teamsProvisioningJob still writes the consent_missing prefix', () => {
    expect(job).toContain('`consent_missing: admin consent required for scopes [');
  });

  it('teamsProvisioningJob still writes the arm_not_configured prefix', () => {
    expect(job).toContain('`arm_not_configured: bot creation needs the ARM setup fields [');
  });

  it('ArmNotConfigured keeps the identity on app_registered, not failed', () => {
    // The acceptance criterion the copy rests on: registration-only is a valid
    // END STATE. If the runner ever moves this to `failed`, the reassuring
    // sentence becomes a lie and this test is what says so.
    expect(job).toContain(
      "await this.recordError(agentId, { state: 'app_registered', lastError: detail });",
    );
  });

  it('the state vocabulary matches the store (and migration 0049)', () => {
    const store = readMiddleware('src', 'platform', 'agentTeamsIdentityStore.ts');
    const block = /export const TEAMS_PROVISIONING_STATES = \[([\s\S]*?)\] as const;/.exec(
      store,
    );
    expect(block).not.toBeNull();
    const serverStates = [...(block?.[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(serverStates).toEqual([...TEAMS_PROVISIONING_STATES]);
  });

  it('the secret ref convention is still the opaque teams_bot_password handle', () => {
    const routes = readMiddleware('src', 'routes', 'operatorAgents.ts');
    expect(routes).toContain(`return \`${TEAMS_BOT_SECRET_REF_PREFIX}\${record.appId}\``);
  });
});

// ---------------------------------------------------------------------------
// State rendering
// ---------------------------------------------------------------------------

describe('state rendering', () => {
  it('gives every state a label key', () => {
    for (const state of TEAMS_PROVISIONING_STATES) {
      expect(teamsProvisioningStateMessage(state).key).toBe(`states.${state}`);
    }
  });

  it('numbers the pipeline but never the failure', () => {
    expect(teamsProvisioningProgress('pending')?.values).toEqual({ step: 1, total: 6 });
    expect(teamsProvisioningProgress('installed')?.values).toEqual({ step: 6, total: 6 });
    expect(teamsProvisioningProgress('failed')).toBeNull();
  });

  it('reads an ArmNotConfigured stop as halted, not failed', () => {
    expect(
      teamsProvisioningTone({ state: 'app_registered', running: false, hasError: true }),
    ).toBe('halted');
    expect(teamsProvisioningTone({ state: 'failed', running: false, hasError: true })).toBe(
      'failed',
    );
    expect(
      teamsProvisioningTone({ state: 'installed', running: false, hasError: false }),
    ).toBe('done');
    expect(teamsProvisioningTone({ state: 'pending', running: true, hasError: false })).toBe(
      'running',
    );
    expect(teamsProvisioningTone({ state: 'pending', running: false, hasError: false })).toBe(
      'idle',
    );
  });

  it('keeps failed as failed even while a re-run is in flight', () => {
    expect(teamsProvisioningTone({ state: 'failed', running: true, hasError: true })).toBe(
      'failed',
    );
  });
});

// ---------------------------------------------------------------------------
// Envelope parsing + the teams_bot block
// ---------------------------------------------------------------------------

/** The GET envelope, shaped exactly as `operatorAgents.ts` emits it. */
function envelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ok: true,
    agent: 'hr-agent',
    state: 'catalog_uploaded',
    running: false,
    provisioner_installed: true,
    identity: {
      bot_slug: 'hr-agent',
      display_name: 'HR Agent',
      app_id: '11111111-2222-3333-4444-555555555555',
      tenant_id: '99999999-8888-7777-6666-555555555555',
      teams_app_id: 'aaaa-bbbb',
      teams_app_external_id: 'cccc-dddd',
      last_error: null,
      created_at: '2026-08-25T10:00:00.000Z',
      updated_at: '2026-08-25T10:05:00.000Z',
    },
    teams_bot: {
      botSlug: 'hr-agent',
      displayName: 'HR Agent',
      appId: '11111111-2222-3333-4444-555555555555',
      appType: 'SingleTenant',
      tenantId: '99999999-8888-7777-6666-555555555555',
      appPasswordSecretRef:
        'teams_bot_password:11111111-2222-3333-4444-555555555555',
    },
    ...overrides,
  };
}

describe('parseTeamsIdentityEnvelope', () => {
  it('projects the snake_case envelope into the camelCase view', () => {
    const view = parseTeamsIdentityEnvelope(envelope());
    expect(view).not.toBeNull();
    expect(view?.agentSlug).toBe('hr-agent');
    expect(view?.state).toBe('catalog_uploaded');
    expect(view?.provisionerInstalled).toBe(true);
    expect(view?.teamsAppExternalId).toBe('cccc-dddd');
    expect(view?.lastError).toBeNull();
    expect(view?.teamsBot?.appType).toBe('SingleTenant');
  });

  it('rejects an envelope whose state this build cannot name', () => {
    // A state with no label is a state with no meaning to the operator —
    // better an explicit "cannot read this" than a blank badge.
    expect(parseTeamsIdentityEnvelope(envelope({ state: 'quantum_entangled' }))).toBeNull();
  });

  it('rejects a non-envelope', () => {
    expect(parseTeamsIdentityEnvelope(null)).toBeNull();
    expect(parseTeamsIdentityEnvelope('nope')).toBeNull();
    expect(parseTeamsIdentityEnvelope([])).toBeNull();
    expect(parseTeamsIdentityEnvelope(envelope({ agent: '' }))).toBeNull();
  });

  it('carries no bot block before the Entra app exists', () => {
    expect(parseTeamsIdentityEnvelope(envelope({ teams_bot: null }))?.teamsBot).toBeNull();
  });

  it('drops the block when the password field is not a vault handle', () => {
    // The table holds no secret by construction; this is the client-side
    // belt-and-braces so an unexpectedly-shaped value is never rendered into a
    // copy-paste box.
    const view = parseTeamsIdentityEnvelope(
      envelope({
        teams_bot: {
          ...(envelope().teams_bot as Record<string, unknown>),
          appPasswordSecretRef: 'hunter2 the actual password',
        },
      }),
    );
    expect(view?.teamsBot).toBeNull();
  });

  it('recognises the middleware-derived ref and refuses a non-handle', () => {
    expect(isTeamsBotSecretRef(`${TEAMS_BOT_SECRET_REF_PREFIX}abc`)).toBe(true);
    expect(isTeamsBotSecretRef('no-colon-here')).toBe(false);
    expect(isTeamsBotSecretRef('has: whitespace')).toBe(false);
    expect(isTeamsBotSecretRef('')).toBe(false);
  });
});

describe('formatTeamsBotsConfig', () => {
  const entry = parseTeamsIdentityEnvelope(envelope())?.teamsBot as TeamsBotConfigEntry;

  it('emits a JSON array the plugin can parse back', () => {
    const block = formatTeamsBotsConfig([entry]);
    expect(JSON.parse(block)).toEqual([entry]);
  });

  it('emits the parseTeamsBotsConfig keys verbatim, in order', () => {
    const rows = JSON.parse(formatTeamsBotsConfig([entry])) as Record<string, string>[];
    expect(Object.keys(rows[0] ?? {})).toEqual([
      'botSlug',
      'displayName',
      'appId',
      'appType',
      'tenantId',
      'appPasswordSecretRef',
    ]);
  });

  it('carries the opaque ref and never a password key', () => {
    const block = formatTeamsBotsConfig([entry]);
    expect(block).toContain(TEAMS_BOT_SECRET_REF_PREFIX);
    // channel-teams rejects an inline `appPassword` outright — never emit one.
    expect(block).not.toContain('"appPassword"');
  });

  it('renders nothing for no entries', () => {
    expect(formatTeamsBotsConfig([])).toBe('[]');
  });
});

// ---------------------------------------------------------------------------
// i18n — every key this unit emits must exist in every locale
// ---------------------------------------------------------------------------

function localeMessages(locale: string): Record<string, unknown> {
  return JSON.parse(
    fs.readFileSync(path.resolve(MESSAGES_DIR, `${locale}.json`), 'utf8'),
  ) as Record<string, unknown>;
}

function lookup(messages: Record<string, unknown>, dotted: string): unknown {
  return dotted.split('.').reduce<unknown>((node, segment) => {
    if (node === null || typeof node !== 'object') return undefined;
    return (node as Record<string, unknown>)[segment];
  }, messages);
}

/** Every key the two modules can produce, gathered the way the UI would. */
function everyEmittedKey(): readonly string[] {
  const keys = new Set<string>();
  const collect = (messages: readonly LocalizedMessage[]) => {
    for (const message of messages) keys.add(message.key);
  };

  for (const state of TEAMS_PROVISIONING_STATES) {
    keys.add(teamsProvisioningStateMessage(state).key);
    const progress = teamsProvisioningProgress(state);
    if (progress) keys.add(progress.key);
  }

  for (const raw of [
    CONSENT_MISSING_RAW,
    ARM_NOT_CONFIGURED_RAW,
    'Graph throttled the request, Retry-After: 42',
    THROTTLED_RAW,
    'ENOTFOUND graph.microsoft.com',
  ]) {
    const detail = classifyTeamsIdentityError(raw);
    if (!detail) continue;
    collect(teamsIdentityErrorMessages(detail));
    keys.add(teamsIdentityErrorTechnicalDetail(detail).key);
    const link = teamsIdentityErrorLink(detail);
    if (link) keys.add(link.labelKey);
  }

  const ready = parseTeamsIdentityEnvelope(envelope());
  const notReady = parseTeamsIdentityEnvelope(envelope({ teams_bot: null }));
  if (ready) collect(teamsBotConfigMessages(ready));
  if (notReady) collect(teamsBotConfigMessages(notReady));

  return [...keys].sort();
}

describe('i18n coverage', () => {
  const NAMESPACE = 'operatorAgents.teamsIdentity';

  for (const locale of ['en', 'de']) {
    it(`${locale}.json explains every key the modules emit`, () => {
      const messages = localeMessages(locale);
      const missing = everyEmittedKey().filter(
        (key) => typeof lookup(messages, `${NAMESPACE}.${key}`) !== 'string',
      );
      expect(missing).toEqual([]);
    });
  }

  it('the consent copy links Microsoft’s admin-consent step', () => {
    const detail = classifyTeamsIdentityError(CONSENT_MISSING_RAW);
    expect(teamsIdentityErrorLink(detail!)).toEqual({
      href: ENTRA_ADMIN_CONSENT_DOCS_URL,
      labelKey: 'errors.consent_missing.consentLink',
    });
    // Nothing else sends the operator off-product.
    expect(
      teamsIdentityErrorLink(classifyTeamsIdentityError(ARM_NOT_CONFIGURED_RAW)!),
    ).toBeNull();
  });

  it('passes the captured names as ICU arguments, never as baked-in copy', () => {
    const messages = teamsIdentityErrorMessages(
      classifyTeamsIdentityError(CONSENT_MISSING_RAW)!,
    );
    expect(messages.map((m) => m.key)).toEqual([
      'errors.consent_missing.what',
      'errors.consent_missing.scopes',
      'errors.consent_missing.next',
    ]);
    expect(messages[1]?.values).toEqual({
      scopes: 'Application.ReadWrite.All, AppCatalog.ReadWrite.All',
      count: 2,
    });
  });

  it('omits the list line when the runner captured no names', () => {
    const messages = teamsIdentityErrorMessages(
      classifyTeamsIdentityError(
        'arm_not_configured: bot creation needs the ARM setup fields [] on the M365 connector',
      )!,
    );
    expect(messages.map((m) => m.key)).toEqual([
      'errors.arm_not_configured.what',
      'errors.arm_not_configured.next',
      'errors.arm_not_configured.keepsRegistration',
    ]);
  });

  it('demotes the raw sentence to a technical detail argument', () => {
    const detail = classifyTeamsIdentityError(THROTTLED_RAW)!;
    expect(teamsIdentityErrorTechnicalDetail(detail)).toEqual({
      key: 'errors.technicalDetail',
      values: { raw: THROTTLED_RAW },
    });
  });

  it('tells the operator the paste is manual', () => {
    const view = parseTeamsIdentityEnvelope(envelope())!;
    expect(teamsBotConfigMessages(view).map((m) => m.key)).toEqual([
      'teamsBot.manualStep',
      'teamsBot.instructions',
      'teamsBot.secretRefNote',
      'teamsBot.followUp',
    ]);
  });
});
