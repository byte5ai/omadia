/**
 * #2043 rollout (D7) — the target's RSC consent check refuses the install.
 *
 * At the rollout `POST /teams/{id}/installedApps` answered 400 because the
 * team's resource-specific consent check rejected the app's permission set.
 * The runner retried it four times as "the catalog entry is still
 * replicating", stored the connector's message cut before the one informative
 * part, and the UI said "a reason omadia cannot classify". It is a permanent
 * refusal with its own code, the full text is kept, and nothing is retried.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  classifyTeamsProvisioningError,
  fullConnectorErrorText,
  graphErrorFactsOf,
  isRscConsentRefusal,
  rscConsentRefusedFailure,
  teamsProvisioningErrorDetailOf,
  TeamsProvisioningJobRunner,
  type TeamsIdentityJobRecord,
  type TeamsProvisionerPort,
} from '../src/services/teamsProvisioningJob.js';

/** The Graph body of the rollout, as the note records it. */
const GRAPH_BODY =
  '{"error":{"code":"BadRequest","message":"Failed to execute TeamsGraphService backend request IsUserAuthorizedToGrantGroupResourceSpecificPermissionsRequest. Workload: Teams. Request Url: https://teamsgraph.teams.microsoft.com/v1.0/groups/c6031502-025c-4297-92c6-b734e17e46c5/isUserAuthorizedToGrantResourceSpecificPermissions, Request Method: POST, Response Status Code: BadRequest","innerError":{"code":"InvalidRequest","date":"2026-11-18T16:58:01"}}}';

function connectorError(message: string, extra: Record<string, unknown> = {}): Error {
  const err = new Error(message);
  err.name = 'ProvisioningRequestError';
  Object.assign(err, { resource: 'graph', step: 'teams.installedApps.add', status: 400, ...extra });
  return err;
}

/** What the connector sends today: the body cut to 200 characters. */
const TRUNCATED = connectorError(
  `graph teams.installedApps.add 400 POST https://graph.microsoft.com/v1.0/teams/c6031502/installedApps body=${GRAPH_BODY.slice(0, 200)}…`,
);
/** What it should send (see the note for the connector): the facts, whole. */
const STRUCTURED = connectorError(
  'graph teams.installedApps.add 400 POST https://graph.microsoft.com/v1.0/teams/c6031502/installedApps body={"error":{"code":"BadRequest","message":"Failed to execute TeamsGraphService backend request…',
  { graphError: { code: 'BadRequest', innerCode: 'InvalidRequest', message: JSON.parse(GRAPH_BODY).error.message, body: GRAPH_BODY } },
);

function runnerWith(installError: () => Error) {
  let row: TeamsIdentityJobRecord = {
    agentId: 'agent-1',
    botSlug: 'mara-test',
    displayName: 'Mara (Test)',
    state: 'pending',
    teamId: 'team-42',
    appId: null,
    tenantId: null,
    teamsAppId: null,
    teamsAppExternalId: null,
    lastError: null,
  } as TeamsIdentityJobRecord;
  let installs = 0;
  const logs: string[] = [];
  const events: string[] = [];
  const provisioner = {
    async createAppRegistration() {
      return { outcome: 'created', value: { appId: 'app-123', registration: { tenantId: 'tenant-9' } } };
    },
    async createBot(input: { botName: string }) {
      return { kind: 'provisioned', bot: { outcome: 'created', value: { botName: input.botName } } };
    },
    buildAppPackage: () => new Uint8Array([80, 75]),
    async uploadToCatalog() {
      return { outcome: 'created', value: { teamsAppId: 'catalog-77' } };
    },
    async getCatalogApp() {
      return { found: false };
    },
    async installToTeam() {
      installs += 1;
      throw installError();
    },
  } as unknown as TeamsProvisionerPort;
  const runner = new TeamsProvisioningJobRunner({
    store: {
      getByAgentId: async () => row,
      update: async (_id: string, patch: Partial<TeamsIdentityJobRecord>) => {
        row = { ...row, ...patch } as TeamsIdentityJobRecord;
        return row;
      },
    } as never,
    getProvisioner: () => provisioner,
    buildMessagingEndpoint: (slug: string) => `https://mw.example.com/api/teams/${slug}/messages`,
    loadPackageAssets: async () => ({
      manifestTemplate: '{"id":"{{APP_ID}}"}',
      params: { APP_ID: 'app-123' },
      icons: { color: new Uint8Array([1]), outline: new Uint8Array([2]) },
      externalId: 'external-abc',
    }),
    timers: { setTimeout: (fn: () => void) => { fn(); return 0 as never; }, clearTimeout: () => undefined } as never,
    catalogReplicationDelayMs: 1,
    events: { clearForAgent: async () => undefined,
      record: async (e: { step: string; status: string; detail?: string | null }) => { events.push(`${e.step}:${e.status}:${e.detail ?? ''}`); } } as never,
    log: (m: string) => logs.push(m),
  } as never);
  return { runner, row: () => row, installs: () => installs, logs, events };
}

describe('RSC consent refusal at the install (#2043 D7)', () => {
  it('is recognised from the full Graph text and from the structured fields, not from a bare 400', () => {
    assert.equal(isRscConsentRefusal(connectorError(`x body=${GRAPH_BODY}`)), true);
    assert.equal(isRscConsentRefusal(STRUCTURED), true);
    assert.equal(isRscConsentRefusal(connectorError('graph teams.installedApps.add 400 body={"error":{"code":"BadRequest"}}')), false);
    assert.equal(
      isRscConsentRefusal(connectorError('x body={"error":{"code":"ResourceSpecificPermissionsMismatch"}}')),
      false,
      'the role mismatch keeps its own code',
    );
    assert.equal(isRscConsentRefusal(connectorError(`x body=${GRAPH_BODY}`, { status: 503 })), false);
    assert.deepEqual(graphErrorFactsOf(STRUCTURED), {
      graphCode: 'BadRequest',
      innerCode: 'InvalidRequest',
      backendRequest: 'IsUserAuthorizedToGrantGroupResourceSpecificPermissionsRequest',
    });
  });

  it('keeps the whole Graph error: nothing is cut before the informative part', () => {
    const text = fullConnectorErrorText(STRUCTURED);
    assert.match(text, /isUserAuthorizedToGrantResourceSpecificPermissions, Request Method: POST/);
    assert.match(text, /"innerError":\{"code":"InvalidRequest"/);
    const failure = rscConsentRefusedFailure('team', STRUCTURED);
    assert.equal(failure.errorCode, 'rsc_consent_refused');
    assert.match(failure.lastError, /^rsc_consent_refused: Teams refused to grant this app's resource-specific permissions in the target team/);
    assert.match(failure.lastError, /permanent, not a replication delay/);
    assert.match(failure.lastError, /Response Status Code: BadRequest/);
    assert.deepEqual(failure.errorDetail, {
      graphCode: 'BadRequest',
      innerCode: 'InvalidRequest',
      backendRequest: 'IsUserAuthorizedToGrantGroupResourceSpecificPermissionsRequest',
    });
  });

  it('the API projection carries code, Graph codes and the raw text; a row without the columns is classified from its sentence', () => {
    const failure = rscConsentRefusedFailure('group-chat', STRUCTURED);
    const classified = classifyTeamsProvisioningError(failure.lastError);
    assert.equal(classified.code, 'rsc_consent_refused');
    assert.equal(classified.backendRequest, 'IsUserAuthorizedToGrantGroupResourceSpecificPermissionsRequest');
    assert.equal(classified.raw, failure.lastError);
    const projected = teamsProvisioningErrorDetailOf(failure.lastError, null, null);
    assert.equal(projected.code, 'rsc_consent_refused');
    assert.match(projected.raw, /target chat/);
  });

  it('the run fails on the FIRST install call: no replication wait, no retry, state failed, own code', async () => {
    const h = runnerWith(() => STRUCTURED);
    const result = await h.runner.enqueue({ agentId: 'agent-1', teamId: 'team-42' });
    assert.equal(h.installs(), 1);
    assert.equal(result.status, 'failed');
    assert.equal((result as { reason?: string }).reason, 'rsc_consent_refused');
    assert.equal(h.row().state, 'failed');
    assert.equal(h.row().errorCode, 'rsc_consent_refused');
    assert.match(h.row().lastError ?? '', /IsUserAuthorizedToGrantGroupResourceSpecificPermissionsRequest/);
    assert.equal(h.logs.some((line) => /replicat/.test(line)), false, 'never called a replication delay');
    assert.equal(h.events.some((e) => e.includes('awaiting_catalog_replication')), false);
  });

  it('a body cut at 200 characters is still recognised when the request name survives the cut', async () => {
    // Whether it survives depends on Microsoft's wording; the connector must
    // stop cutting (see the rollout note). When it does not survive, the
    // runner falls back to the bounded replication wait and then reports a
    // configuration error with whatever text it was given.
    assert.equal(isRscConsentRefusal(TRUNCATED), true);
    const h = runnerWith(() => TRUNCATED);
    const result = await h.runner.enqueue({ agentId: 'agent-1', teamId: 'team-42' });
    assert.equal(h.installs(), 1);
    assert.equal((result as { reason?: string }).reason, 'rsc_consent_refused');
  });
});

/**
 * What the M365 connector really sends, per version (its `http.ts`):
 *
 *   0.9.1  message `graph <step> 400 POST <url> body=<redacted body, long>`
 *          plus `graphError { code, innerCode, message, requestId,
 *          clientRequestId, body }`. The 62-letter request name is no longer
 *          redacted.
 *   0.9.0  the same message with the body cut to 200 characters, no
 *          `graphError`, and every unbroken run of 60+ characters replaced by
 *          `[redacted]`. That redaction, not the cut, removed the request
 *          name at the rollout.
 */
const INSTALL_URL =
  'https://graph.microsoft.com/v1.0/teams/c6031502-025c-4297-92c6-b734e17e46c5/installedApps';
const GRAPH_MESSAGE = (JSON.parse(GRAPH_BODY) as { error: { message: string } }).error.message;

const CONNECTOR_0_9_1 = connectorError(`graph teams.installedApps.add 400 POST ${INSTALL_URL} body=${GRAPH_BODY}`, {
  graphError: {
    code: 'BadRequest',
    innerCode: 'InvalidRequest',
    message: GRAPH_MESSAGE,
    requestId: '0f3f9a52-5a3c-4d0e-9d57-1c5f0a9b7e11',
    clientRequestId: '6a0d7f0e-1f8e-4c7a-8a43-0d2b6e1c9f55',
    body: GRAPH_BODY,
  },
});

const REDACTED_0_9_0 = GRAPH_BODY.replace(/\b[A-Za-z0-9_-]{60,}\b/g, '[redacted]');
const CONNECTOR_0_9_0 = connectorError(
  `graph teams.installedApps.add 400 POST ${INSTALL_URL.slice(0, 119)}… body=${REDACTED_0_9_0.slice(0, 199)}…`,
);

describe('RSC consent refusal, against what the connector really sends (#2043 D7)', () => {
  it('connector 0.9.1: classified from its graphError, with the request name and both codes', async () => {
    assert.equal(isRscConsentRefusal(CONNECTOR_0_9_1), true);
    assert.deepEqual(graphErrorFactsOf(CONNECTOR_0_9_1), {
      graphCode: 'BadRequest',
      innerCode: 'InvalidRequest',
      backendRequest: 'IsUserAuthorizedToGrantGroupResourceSpecificPermissionsRequest',
    });
    // The body is already in the message: it is not stored twice.
    const text = fullConnectorErrorText(CONNECTOR_0_9_1);
    assert.equal(text.split('IsUserAuthorizedToGrantGroupResourceSpecificPermissionsRequest').length - 1, 1);

    const h = runnerWith(() => CONNECTOR_0_9_1);
    const result = await h.runner.enqueue({ agentId: 'agent-1', teamId: 'team-42' });
    assert.equal(h.installs(), 1);
    assert.equal((result as { reason?: string }).reason, 'rsc_consent_refused');
    assert.equal(h.row().errorCode, 'rsc_consent_refused');
    assert.match(h.row().lastError ?? '', /Response Status Code: BadRequest/);
  });

  it('connector 0.9.1 with only the structured fields (a message someone shortened) is still classified', () => {
    const structuredOnly = connectorError('graph teams.installedApps.add 400', {
      graphError: { code: 'BadRequest', innerCode: 'InvalidRequest', message: GRAPH_MESSAGE },
    });
    assert.equal(isRscConsentRefusal(structuredOnly), true);
    assert.match(fullConnectorErrorText(structuredOnly), / — Graph: Failed to execute TeamsGraphService backend request IsUserAuthorized/);
  });

  it('connector 0.9.0: the name was redacted and the URL cut, so this is NOT recognisable and takes the bounded replication wait', async () => {
    // Pinned as it is, not as one would wish: this is why the rollout showed
    // "replicating" and "cannot classify". The kernel cannot know more than
    // it is told; 0.9.1 tells it.
    assert.doesNotMatch(CONNECTOR_0_9_0.message, /IsUserAuthorizedToGrant/i);
    assert.match(CONNECTOR_0_9_0.message, /backend request \[redacted\]/);
    assert.equal(isRscConsentRefusal(CONNECTOR_0_9_0), false);

    const h = runnerWith(() => CONNECTOR_0_9_0);
    const result = await h.runner.enqueue({ agentId: 'agent-1', teamId: 'team-42' });
    assert.equal(result.status, 'failed');
    assert.ok(h.installs() > 1, 'waited for a replication that was not the cause');
    assert.equal(h.row().errorCode, 'unknown');
    assert.match(h.row().lastError ?? '', /treat as a configuration error, not a timing one/);
  });
});
