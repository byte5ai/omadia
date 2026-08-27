import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { TeamsIdentityLastErrorDetailDto } from '../agents';
import {
  ENTRA_ADMIN_CONSENT_DOCS_URL,
  TEAMS_BOT_SECRET_REF_PREFIX,
  TEAMS_PROVISIONING_STATES,
  formatTeamsBotsConfig,
  isTeamsBotSecretRef,
  parseTeamsIdentityEnvelope,
  teamsBotConfigMessages,
  teamsIdentityErrorLink,
  teamsIdentityErrorMessages,
  teamsIdentityErrorTechnicalDetail,
  type LocalizedMessage,
  type TeamsBotConfigEntry,
} from '../teamsIdentity';

/**
 * #860 / W2a — the operator screen must be able to say, in the operator's own
 * language, what the Teams provisioning run did and what to do about it.
 *
 * WHAT IS **NOT** HERE, on purpose: a parser for the `last_error` sentence.
 * The middleware classifies it server-side next to the code that writes it
 * (`services/teamsProvisioningJob.ts`) and the route emits the result as
 * `identity.last_error_detail`; the round trip is pinned by
 * `middleware/test/teamsProvisioningLastError.test.ts`. A second classifier in
 * web-ui would be a duplicate primitive that drifts the day a message changes.
 *
 * Three classes of assertion live here, and the middle one is the reason this
 * file reads middleware sources at all:
 *
 *   1. the copy shaping turns a structured detail into i18n keys + ICU
 *      arguments, and omits every line whose argument the server did not send;
 *   2. the sentences and the state vocabulary are read out of the middleware,
 *      so a reworded producer or a moved state fails here instead of silently
 *      degrading the UI in production;
 *   3. every i18n key this module can emit exists in BOTH locales, so nothing
 *      it produces can reach a screen as a bare key.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..');
const MESSAGES_DIR = path.resolve(HERE, '..', '..', '..', 'messages');

function readMiddleware(...segments: string[]): string {
  return fs.readFileSync(path.resolve(REPO_ROOT, 'middleware', ...segments), 'utf8');
}

/** The sentences the job runner persists, reproduced verbatim. */
const CONSENT_MISSING_RAW =
  'consent_missing: admin consent required for scopes [Application.ReadWrite.All, AppCatalog.ReadWrite.All] — grant them in the customer tenant, then re-run provisioning';
const ARM_NOT_CONFIGURED_RAW =
  'arm_not_configured: bot creation needs the ARM setup fields [azure_subscription_id, azure_resource_group] on the M365 connector — configure them, then re-run provisioning (the app registration is kept)';
/** A throttle that exhausted the budget WITHOUT a Retry-After header. */
const THROTTLED_RAW = 'throttled: 429 from Graph (gave up after 3 attempts)';

/**
 * `last_error_detail` fixtures — the shape the ROUTE emits, not something this
 * file derived. Hand-writing them keeps the parser where it belongs (the
 * middleware) while still exercising every copy branch.
 */
const CONSENT_DETAIL: TeamsIdentityLastErrorDetailDto = {
  code: 'consent_missing',
  scopes: ['Application.ReadWrite.All', 'AppCatalog.ReadWrite.All'],
  raw: CONSENT_MISSING_RAW,
};
const ARM_DETAIL: TeamsIdentityLastErrorDetailDto = {
  code: 'arm_not_configured',
  fields: ['azure_subscription_id', 'azure_resource_group'],
  raw: ARM_NOT_CONFIGURED_RAW,
};
const ARM_DETAIL_NO_FIELDS: TeamsIdentityLastErrorDetailDto = {
  code: 'arm_not_configured',
  raw: 'arm_not_configured: bot creation needs the ARM setup fields [] on the M365 connector',
};
const THROTTLED_DETAIL_WITH_HINT: TeamsIdentityLastErrorDetailDto = {
  code: 'throttled',
  retryAfterSeconds: 42,
  raw: 'throttled: 429 from Graph (gave up after 3 attempts; retry after 42s)',
};
const THROTTLED_DETAIL_NO_HINT: TeamsIdentityLastErrorDetailDto = {
  code: 'throttled',
  raw: THROTTLED_RAW,
};
const UNKNOWN_DETAIL: TeamsIdentityLastErrorDetailDto = {
  code: 'unknown',
  raw: 'ENOTFOUND graph.microsoft.com',
};

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

  it('teamsProvisioningJob still prefixes an exhausted throttle', () => {
    expect(job).toContain('`throttled: ${message} (gave up after ${String(attempts)} attempts${hint})`');
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

const ALL_DETAILS: readonly TeamsIdentityLastErrorDetailDto[] = [
  CONSENT_DETAIL,
  ARM_DETAIL,
  ARM_DETAIL_NO_FIELDS,
  THROTTLED_DETAIL_WITH_HINT,
  THROTTLED_DETAIL_NO_HINT,
  UNKNOWN_DETAIL,
];

/** Every key this module can produce, gathered the way the UI would. */
function everyEmittedKey(): readonly string[] {
  const keys = new Set<string>();
  const collect = (messages: readonly LocalizedMessage[]) => {
    for (const message of messages) keys.add(message.key);
  };

  for (const state of TEAMS_PROVISIONING_STATES) keys.add(`states.${state}`);

  for (const detail of ALL_DETAILS) {
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
    it(`${locale}.json explains every key the module emits`, () => {
      const messages = localeMessages(locale);
      const missing = everyEmittedKey().filter(
        (key) => typeof lookup(messages, `${NAMESPACE}.${key}`) !== 'string',
      );
      expect(missing).toEqual([]);
    });
  }

  it('the consent copy links Microsoft’s admin-consent step', () => {
    expect(teamsIdentityErrorLink(CONSENT_DETAIL)).toEqual({
      href: ENTRA_ADMIN_CONSENT_DOCS_URL,
      labelKey: 'errors.consent_missing.consentLink',
    });
    // Nothing else sends the operator off-product.
    expect(teamsIdentityErrorLink(ARM_DETAIL)).toBeNull();
  });

  it('passes the captured names as ICU arguments, never as baked-in copy', () => {
    const messages = teamsIdentityErrorMessages(CONSENT_DETAIL);
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
    expect(teamsIdentityErrorMessages(ARM_DETAIL_NO_FIELDS).map((m) => m.key)).toEqual([
      'errors.arm_not_configured.what',
      'errors.arm_not_configured.next',
      'errors.arm_not_configured.keepsRegistration',
    ]);
  });

  it('names the wait only when Microsoft actually sent a Retry-After hint', () => {
    // `throttleHintOf` returns {} when the connector sent no header, so
    // `retryAfterSeconds` is genuinely absent. Rendering the line anyway with a
    // defaulted 0 would tell the operator to retry immediately at the exact
    // moment the runner gave up.
    expect(teamsIdentityErrorMessages(THROTTLED_DETAIL_WITH_HINT).map((m) => m.key)).toEqual(
      ['errors.throttled.what', 'errors.throttled.retryAfter', 'errors.throttled.next'],
    );
    expect(teamsIdentityErrorMessages(THROTTLED_DETAIL_NO_HINT).map((m) => m.key)).toEqual([
      'errors.throttled.what',
      'errors.throttled.next',
    ]);
  });

  it('demotes the raw sentence to a technical detail argument', () => {
    expect(teamsIdentityErrorTechnicalDetail(THROTTLED_DETAIL_NO_HINT)).toEqual({
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
