/**
 * #914 — the agent's authored identity feeding its Teams app package.
 *
 * Before this, every provisioned bot rendered the same manifest shape: the
 * provisioning row's name, a synthesized `"<name> — Omadia agent for
 * Microsoft Teams"` description, one hard-coded accent colour and the icons
 * that ship inside the channel-teams package. Ten agents in a tenant, ten
 * identical faces.
 *
 * What is proven here:
 *  1. An agent WITHOUT an identity renders byte-identical output to before —
 *     the fallback is not a rewrite of the old behaviour, it IS the old
 *     behaviour.
 *  2. An authored identity supplies name, both descriptions, accent colour
 *     and the colour icon.
 *  3. The manifest version follows the identity's revision, because Teams
 *     only accepts an update whose version increased.
 *  4. A missing outline icon falls back to the packaged one rather than
 *     shipping a white square.
 *  5. A failing identity read is NOT swallowed: shipping the fallback package
 *     under a version that claims to be the edited one is worse than failing
 *     the run.
 */

import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  createTeamsAppPackageAssetLoader,
  type TeamsAppPackageIdentity,
} from '../src/services/teamsAppPackageAssets.js';
import type { TeamsIdentityJobRecord } from '../src/services/teamsProvisioningJob.js';

const TEMPLATE = JSON.stringify({
  id: '{{APP_ID}}',
  version: '{{VERSION}}',
  name: { short: '{{NAME_SHORT}}', full: '{{NAME_FULL}}' },
  description: { short: '{{DESCRIPTION}}', full: '{{DESCRIPTION_FULL}}' },
  accentColor: '{{ACCENT_COLOR}}',
  bots: [{ botId: '{{BOT_ID}}' }],
});

const PACKAGED_COLOR = Buffer.from([0xc0, 0x10, 0x12]);
const PACKAGED_OUTLINE = Buffer.from([0x00, 0x17, 0x11, 0xee]);

const ROW: TeamsIdentityJobRecord = {
  agentId: 'agent-1',
  botSlug: 'hr-bot',
  displayName: 'HR Bot',
  state: 'app_registered',
  appId: 'app-123',
  tenantId: 'tenant-9',
  teamsAppId: null,
  teamsAppExternalId: null,
  lastError: null,
};

/** A stand-in for the installed channel-teams package root. */
async function packageRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'omadia-teams-pkg-'));
  const dir = path.join(root, 'appPackage');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'manifest.json.template'), TEMPLATE, 'utf8');
  await writeFile(path.join(dir, 'color.png'), PACKAGED_COLOR);
  await writeFile(path.join(dir, 'outline.png'), PACKAGED_OUTLINE);
  return root;
}

function loaderFor(
  root: string,
  loadIdentity?: (agentId: string) => Promise<TeamsAppPackageIdentity | undefined>,
) {
  return createTeamsAppPackageAssetLoader({
    getChannelTeamsPackageRoot: () => root,
    getPublicBaseUrl: () => 'https://mw.example.com',
    ...(loadIdentity ? { loadIdentity } : {}),
  });
}

describe('teams app package — authored identity (#914)', () => {
  it('renders the pre-#914 package for an agent with no identity', async () => {
    const assets = await loaderFor(await packageRoot())(ROW);
    assert.equal(assets.params['VERSION'], '1.0.0');
    assert.equal(assets.params['NAME_SHORT'], 'HR Bot');
    assert.equal(
      assets.params['DESCRIPTION'],
      'HR Bot — Omadia agent for Microsoft Teams',
    );
    assert.equal(assets.params['ACCENT_COLOR'], '#714B67');
    assert.deepEqual(Buffer.from(assets.icons.color), PACKAGED_COLOR);
    assert.deepEqual(Buffer.from(assets.icons.outline), PACKAGED_OUTLINE);
  });

  it('renders the same package when the deployment has an identity for a DIFFERENT agent', async () => {
    const assets = await loaderFor(await packageRoot(), () =>
      Promise.resolve(undefined),
    )(ROW);
    assert.equal(assets.params['NAME_SHORT'], 'HR Bot');
    assert.equal(assets.params['ACCENT_COLOR'], '#714B67');
  });

  it('takes name, descriptions, colour and icon from the authored identity', async () => {
    const identity: TeamsAppPackageIdentity = {
      displayName: 'Personalbot',
      shortDescription: 'Answers HR questions',
      longDescription: 'The long story about what this agent does.',
      accentColor: '#0055AA',
      revision: 4,
      icons: {
        color: new Uint8Array([9, 9, 9]),
        outline: new Uint8Array([8, 8]),
      },
    };
    const assets = await loaderFor(await packageRoot(), () =>
      Promise.resolve(identity),
    )(ROW);

    assert.equal(assets.params['NAME_SHORT'], 'Personalbot');
    assert.equal(assets.params['NAME_FULL'], 'Personalbot');
    assert.equal(assets.params['DESCRIPTION'], 'Answers HR questions');
    assert.equal(
      assets.params['DESCRIPTION_FULL'],
      'The long story about what this agent does.',
    );
    assert.equal(assets.params['ACCENT_COLOR'], '#0055AA');
    // The revision IS the version — that is what makes a re-publish
    // acceptable to Teams.
    assert.equal(assets.params['VERSION'], '1.0.4');
    assert.deepEqual(Buffer.from(assets.icons.color), Buffer.from([9, 9, 9]));
    assert.deepEqual(Buffer.from(assets.icons.outline), Buffer.from([8, 8]));
  });

  it('keeps the packaged outline when the avatar could not produce one', async () => {
    const assets = await loaderFor(await packageRoot(), () =>
      Promise.resolve({
        displayName: null,
        shortDescription: null,
        longDescription: null,
        accentColor: null,
        revision: 2,
        icons: { color: new Uint8Array([9]), outline: null },
      }),
    )(ROW);
    assert.deepEqual(Buffer.from(assets.icons.color), Buffer.from([9]));
    assert.deepEqual(Buffer.from(assets.icons.outline), PACKAGED_OUTLINE);
    // An identity that authored no name still falls back to the row's.
    assert.equal(assets.params['NAME_SHORT'], 'HR Bot');
    assert.equal(assets.params['VERSION'], '1.0.2');
  });

  it('falls back to the short description when no long one was authored', async () => {
    const assets = await loaderFor(await packageRoot(), () =>
      Promise.resolve({
        displayName: null,
        shortDescription: 'Answers HR questions',
        longDescription: null,
        accentColor: null,
        revision: 1,
        icons: null,
      }),
    )(ROW);
    assert.equal(assets.params['DESCRIPTION_FULL'], 'Answers HR questions');
  });

  it('surfaces a failing identity read instead of shipping the fallback', async () => {
    await assert.rejects(
      loaderFor(await packageRoot(), () =>
        Promise.reject(new Error('database is down')),
      )(ROW),
      /database is down/,
    );
  });
});
