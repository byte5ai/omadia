/**
 * `GET /:slug/teams-identity/package` — the download fallback (byte5ai/omadia#924).
 *
 * WHAT THIS PINS:
 *
 *   - IT SERVES A ZIP, with the headers a browser needs to save it. A route
 *     that answered JSON, or omitted `Content-Disposition`, would render as a
 *     wall of binary in a tab instead of a file on disk.
 *   - IT REBUILDS PER REQUEST. Two calls either side of an identity edit must
 *     produce different bytes; a cached or stored blob would hand the operator
 *     a package that differs from what provisioning would upload — the exact
 *     drift this endpoint was designed to avoid.
 *   - IT IS AVAILABLE WHENEVER IT IS BUILDABLE, not only after a failure. The
 *     package is a pure render, so gating it on an error state would withhold
 *     a harmless artefact from every operator calmly preparing a rollout.
 *   - THE FILENAME IS SAFE. It lands in a response header, where a quote or a
 *     newline is a header-injection primitive.
 *   - A MOUNT THAT CANNOT RENDER SAYS SO (501), rather than 500ing.
 */

import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import express from 'express';

import type { ConfigStore, OrchestratorRegistry } from '@omadia/orchestrator';

import {
  createOperatorAgentsRouter,
  teamsPackageFilenameFor,
  type OperatorTeamsIdentityRecord,
} from '../src/routes/operatorAgents.js';
import { listenLoopback } from './_helpers/listenLoopback.js';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

class FakeConfigStore {
  getAgentBySlug(
    slug: string,
  ): Promise<{ id: string; slug: string; name: string } | undefined> {
    return Promise.resolve(
      slug === 'hr' ? { id: 'agent-1', slug: 'hr', name: 'HR' } : undefined,
    );
  }
}

const ROW: OperatorTeamsIdentityRecord = {
  agentId: 'agent-1',
  botSlug: 'hr',
  displayName: 'HR Bot',
  state: 'installed',
  teamId: 'team-1',
  appId: 'app-1',
  tenantId: 'tenant-1',
  teamsAppId: 'teams-app-1',
  teamsAppExternalId: 'external-1',
  lastError: null,
};

describe('#924 Teams app package download', () => {
  let server: Server;
  let baseUrl: string;
  let row: OperatorTeamsIdentityRecord | undefined = ROW;
  let canBuild = true;
  let buildCalls = 0;
  /** Stands in for the identity that feeds the manifest — changing it must
   *  change the bytes, which is the whole "rebuild, never store" claim. */
  let manifestRevision = 1;

  before(async () => {
    const app = express();
    app.use(express.json());
    app.use(
      '/api/v1/operator/agents',
      createOperatorAgentsRouter({
        getConfigStore: () => new FakeConfigStore() as unknown as ConfigStore,
        getRegistry: () =>
          ({ reload: () => Promise.resolve() }) as unknown as OrchestratorRegistry,
        getChatSessionStore: () => undefined,
        getTeamsIdentity: () => ({
          store: {
            getByAgentId: () => Promise.resolve(row),
            ensureForAgent: () => Promise.resolve(ROW),
          },
          runner: {
            enqueue: () => Promise.resolve(undefined),
            isRunning: () => false,
            runningTeamId: () => null,
          },
          isProvisionerInstalled: () => true,
          ...(canBuild
            ? {
                buildAppPackage: (record: OperatorTeamsIdentityRecord) => {
                  buildCalls += 1;
                  // A stand-in render: the bytes depend on the CURRENT
                  // identity, exactly as the real manifest does.
                  return Promise.resolve(
                    new TextEncoder().encode(
                      `PK-fake-zip:${record.botSlug}:rev${String(manifestRevision)}`,
                    ),
                  );
                },
              }
            : {}),
        }),
      }),
    );
    server = await listenLoopback(app);
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${String(addr.port)}/api/v1/operator/agents`;
  });

  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('serves the package as a saveable zip', async () => {
    const res = await fetch(`${baseUrl}/hr/teams-identity/package`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/zip');
    assert.match(
      res.headers.get('content-disposition') ?? '',
      /^attachment; filename="omadia-teams-hr\.zip"$/,
    );
    // Never cached: a cached copy is the stored-blob drift this route avoids.
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const body = Buffer.from(await res.arrayBuffer());
    assert.equal(body.toString(), 'PK-fake-zip:hr:rev1');
    assert.equal(res.headers.get('content-length'), String(body.byteLength));
  });

  it('rebuilds on every request, so an identity edit reaches the download', async () => {
    const before = buildCalls;
    const first = await (await fetch(`${baseUrl}/hr/teams-identity/package`)).text();
    manifestRevision = 2; // the operator renames the agent
    const second = await (await fetch(`${baseUrl}/hr/teams-identity/package`)).text();

    assert.equal(buildCalls, before + 2, 'both requests rendered');
    assert.notEqual(first, second, 'a stored blob would have returned stale bytes');
    manifestRevision = 1;
  });

  it('is offered on a healthy identity, not only after a failure', async () => {
    // ROW is `installed` with no last_error — the calm case.
    const res = await fetch(`${baseUrl}/hr/teams-identity/package`);
    assert.equal(res.status, 200);
  });

  it('404s for an unknown agent and for an agent without an identity row', async () => {
    const unknownAgent = await fetch(`${baseUrl}/ghost/teams-identity/package`);
    assert.equal(unknownAgent.status, 404);

    row = undefined;
    const noIdentity = await fetch(`${baseUrl}/hr/teams-identity/package`);
    assert.equal(noIdentity.status, 404);
    assert.equal(
      ((await noIdentity.json()) as { error: string }).error,
      'teams_identity_not_found',
    );
    row = ROW;
  });

  it('501s with a capability code when this mount cannot render a package', async () => {
    canBuild = false;
    // The dependency is resolved per request, so flipping it takes effect
    // without rebuilding the router — same as a connector being removed.
    const res = await fetch(`${baseUrl}/hr/teams-identity/package`);
    assert.equal(res.status, 501);
    assert.equal(
      ((await res.json()) as { error: string }).error,
      'teams_app_package_unavailable',
    );
    canBuild = true;
  });
});

describe('#924 teamsPackageFilenameFor', () => {
  it('names the file after the BOT slug — what appears in the Teams catalogue', () => {
    assert.equal(teamsPackageFilenameFor({ botSlug: 'sales' }), 'omadia-teams-sales');
  });

  it('cannot smuggle a header break or a quote into Content-Disposition', () => {
    const hostile = teamsPackageFilenameFor({
      botSlug: 'a"b\r\nX-Injected: yes',
    });
    for (const forbidden of ['"', '\r', '\n', ':', ' ']) {
      assert.equal(
        hostile.includes(forbidden),
        false,
        `filename must not contain ${JSON.stringify(forbidden)}`,
      );
    }
  });

  it('falls back to a usable name rather than an empty one', () => {
    assert.equal(teamsPackageFilenameFor({ botSlug: '---' }), 'omadia-teams-app');
  });
});
