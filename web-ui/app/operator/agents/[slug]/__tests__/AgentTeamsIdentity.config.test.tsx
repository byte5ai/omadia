import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithIntl } from '../../../../_lib/test-utils';
import type {
  TeamsBotConfigEntryDto,
  TeamsIdentityStatusDto,
} from '../../../../_lib/agents';
import { AgentTeamsIdentity } from '../_components/AgentTeamsIdentity';

/**
 * Epic #860, wave W2a — the `teams_bots` config block on the Teams identity
 * panel.
 *
 * The last mile of provisioning is NOT automated: the operator copies this
 * block into the channel-teams `teams_bots` setup field by hand. These tests
 * pin the three things that make that hand-off survivable:
 *
 *   1. THE BLOCK IS PASTE-COMPATIBLE. channel-teams `JSON.parse`s the setup
 *      field into `parseTeamsBotsConfig` entries, so the rendered text has to
 *      be a JSON ARRAY whose keys are exactly botSlug/displayName/appId/
 *      appType/tenantId/appPasswordSecretRef. Anything reshaped here is a
 *      block the plugin rejects on paste — a failure that only shows up in a
 *      customer tenant, which is why it is asserted by parsing the DOM text
 *      back rather than by matching a string.
 *
 *   2. THE MANUAL STEP IS STATED. Silence here reads as "this synced itself".
 *      The copy has to say the paste is manual AND that automatic config sync
 *      is a follow-up that does not happen today.
 *
 *   3. NO SECRET IS RENDERED. `appPasswordSecretRef` is an opaque vault ref
 *      (`teams_bot_password:<appId>`); a payload carrying anything that is not
 *      ref-shaped must drop the whole block rather than print it into a
 *      copy-paste box.
 *
 * Before the `app_registered` step the route sends `teams_bot: null` — a
 * normal early state, so it gets an explanation, not an empty box.
 */

const { mockGet, mockProvision } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockProvision: vi.fn(),
}));

vi.mock('../../../../_lib/agents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../_lib/agents')>()),
  getAgentTeamsIdentity: mockGet,
  provisionAgentTeamsIdentity: mockProvision,
}));

const APP_ID = '11111111-2222-3333-4444-555555555555';
const TENANT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

const TEAMS_BOT: TeamsBotConfigEntryDto = {
  botSlug: 'sales-bot',
  displayName: 'Sales Bot',
  appId: APP_ID,
  appType: 'SingleTenant',
  tenantId: TENANT_ID,
  appPasswordSecretRef: `teams_bot_password:${APP_ID}`,
};

function statusDto(
  overrides: Partial<TeamsIdentityStatusDto> = {},
): TeamsIdentityStatusDto {
  return {
    ok: true,
    agent: 'sales-bot',
    state: 'installed',
    running: false,
    provisioner_installed: true,
    identity: {
      bot_slug: 'sales-bot',
      display_name: 'Sales Bot',
      app_id: APP_ID,
      tenant_id: TENANT_ID,
      teams_app_id: '99999999-8888-7777-6666-555555555555',
      teams_app_external_id: 'com.byte5.omadia.sales-bot',
      last_error: null,
      created_at: '2026-08-27T08:00:00.000Z',
      updated_at: '2026-08-27T08:05:00.000Z',
    },
    teams_bot: TEAMS_BOT,
    ...overrides,
  };
}

/** The rendered block, parsed back the way channel-teams would parse it. */
async function readRenderedBlock(): Promise<unknown> {
  const block = await screen.findByLabelText(
    /teams_bots configuration block for sales-bot/,
  );
  return JSON.parse(block.textContent ?? '');
}

/** The single entry of the rendered block, narrowed for key-level assertions. */
async function readRenderedEntry(): Promise<Record<string, unknown>> {
  const parsed = await readRenderedBlock();
  expect(Array.isArray(parsed)).toBe(true);
  const [entry] = parsed as readonly Record<string, unknown>[];
  expect(entry).toBeTruthy();
  return entry as Record<string, unknown>;
}

beforeEach(() => {
  mockGet.mockReset();
  mockProvision.mockReset();
  mockGet.mockResolvedValue(statusDto());
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AgentTeamsIdentity — teams_bots config block (#860 W2a)', () => {
  it('renders the teams_bot entry verbatim as a paste-able JSON array', async () => {
    renderWithIntl(<AgentTeamsIdentity slug="sales-bot" />);

    const parsed = await readRenderedBlock();

    // A JSON ARRAY: the setup field is a string field the plugin JSON.parses
    // into a list, so a bare object would not paste.
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toEqual([TEAMS_BOT]);

    // Keys, in the declaration order channel-teams' parser documents. Order is
    // cosmetic for the parser but load-bearing for an operator diffing the
    // block against what is already configured.
    expect(Object.keys(await readRenderedEntry())).toEqual([
      'botSlug',
      'displayName',
      'appId',
      'appType',
      'tenantId',
      'appPasswordSecretRef',
    ]);
  });

  it('states plainly that the paste is manual and that automatic sync is a follow-up', async () => {
    renderWithIntl(<AgentTeamsIdentity slug="sales-bot" />);

    expect(
      await screen.findByText(
        'One manual step is left: this block has to be pasted into the Teams channel plugin by hand.',
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        'Copy the block and paste it into the teams_bots setup field of the Teams channel plugin, then save.',
      ),
    ).toBeTruthy();
    // The out-of-scope promise, said out loud rather than left to assumption.
    expect(
      screen.getByText(
        'Writing this configuration automatically is a planned follow-up and does not happen today.',
      ),
    ).toBeTruthy();
  });

  it('copies the exact block text to the clipboard', async () => {
    // `userEvent.setup()` installs its own `navigator.clipboard` stub, so the
    // spy has to be attached AFTER it — assigning over the property beforehand
    // is silently replaced and the assertion would test userEvent's stub.
    const user = userEvent.setup();
    const writeText = vi
      .spyOn(navigator.clipboard, 'writeText')
      .mockResolvedValue(undefined);
    renderWithIntl(<AgentTeamsIdentity slug="sales-bot" />);

    await user.click(await screen.findByRole('button', { name: 'Copy' }));

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(writeText.mock.calls[0]?.[0]))).toEqual([
      TEAMS_BOT,
    ]);
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeTruthy();
  });

  it('leaves the block visible when the clipboard write is refused', async () => {
    const user = userEvent.setup();
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(
      new Error('not allowed'),
    );
    renderWithIntl(<AgentTeamsIdentity slug="sales-bot" />);

    await user.click(await screen.findByRole('button', { name: 'Copy' }));

    // Soft failure: no alarm, and the text stays selectable for a manual copy.
    expect(await readRenderedBlock()).toEqual([TEAMS_BOT]);
    expect(screen.queryByRole('button', { name: 'Copied' })).toBeNull();
  });

  it('carries the opaque vault ref and never a password', async () => {
    renderWithIntl(<AgentTeamsIdentity slug="sales-bot" />);

    const entry = await readRenderedEntry();
    expect(entry.appPasswordSecretRef).toBe(`teams_bot_password:${APP_ID}`);
    expect(entry).not.toHaveProperty('appPassword');
    expect(entry).not.toHaveProperty('clientSecret');
  });

  it('drops the whole block when the ref is not ref-shaped', async () => {
    mockGet.mockResolvedValue(
      statusDto({
        // A leaked literal instead of a handle: rendering it would put secret
        // material into a copy-paste box.
        teams_bot: { ...TEAMS_BOT, appPasswordSecretRef: 'hunter2 please' },
      }),
    );
    renderWithIntl(<AgentTeamsIdentity slug="sales-bot" />);

    expect(
      await screen.findByText(
        'There is no bot configuration yet — it appears once the Entra app registration exists.',
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/hunter2/)).toBeNull();
    expect(
      screen.queryByLabelText(/teams_bots configuration block/),
    ).toBeNull();
  });

  it('explains the absence before the app registration exists', async () => {
    mockGet.mockResolvedValue(
      statusDto({
        state: 'pending',
        teams_bot: null,
        identity: {
          ...statusDto().identity,
          app_id: null,
          tenant_id: null,
          teams_app_id: null,
          teams_app_external_id: null,
        },
      }),
    );
    renderWithIntl(<AgentTeamsIdentity slug="sales-bot" />);

    // An explanation, not an empty box — `teams_bot: null` is a normal early
    // state, not missing data.
    expect(
      await screen.findByText(
        'There is no bot configuration yet — it appears once the Entra app registration exists.',
      ),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Copy' })).toBeNull();
  });
});
