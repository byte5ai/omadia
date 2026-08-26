/**
 * Shared test stub for the `teamsProvisioner@1` accessor (wave W1a, epic
 * byte5ai/omadia#860).
 *
 * The `@omadia/integration-microsoft365` connector is not vendored in this
 * checkout, so tests for every kernel-side consumer (the choke-point module,
 * the provisioning job runner, the operator teams-identity routes) drive a
 * stub that IMPLEMENTS the mirrored {@link TeamsProvisionerAccessor}
 * interface — the compiler keeps the stub honest against the contract.
 *
 * Defaults answer every step with a plausible `'created'` outcome; override
 * individual methods (or `tenantMode`/`canCreateBots`) per test. Every
 * invocation is recorded in `calls` so tests can assert ordering and inputs.
 */

import type {
  AppRegistration,
  TeamsProvisionerAccessor,
} from '../../src/platform/teamsProvisionerService.js';

/** One recorded stub invocation: method name plus the arguments it got. */
export interface StubProvisionerCall {
  readonly method: keyof TeamsProvisionerAccessor;
  readonly args: readonly unknown[];
}

export interface StubTeamsProvisioner {
  readonly accessor: TeamsProvisionerAccessor;
  /** Chronological journal of every method invocation. */
  readonly calls: readonly StubProvisionerCall[];
}

const STUB_TENANT_ID = '11111111-2222-3333-4444-555555555555';

function stubRegistration(displayName: string, uniqueName?: string): AppRegistration {
  return {
    appId: 'app-0000',
    objectId: 'obj-0000',
    tenantId: STUB_TENANT_ID,
    tenantMode: 'customer',
    signInAudience: 'AzureADMyOrg',
    displayName,
    ...(uniqueName === undefined ? {} : { uniqueName }),
  };
}

/**
 * Build a stub accessor. `overrides` replaces whole methods/fields; the
 * defaults below stay in place for everything else.
 */
export function createStubTeamsProvisioner(
  overrides: Partial<TeamsProvisionerAccessor> = {},
): StubTeamsProvisioner {
  const calls: StubProvisionerCall[] = [];

  const defaults: TeamsProvisionerAccessor = {
    tenantMode: 'customer',
    canCreateBots: true,
    createAppRegistration: async (input) => ({
      outcome: 'created',
      value: {
        appId: 'app-0000',
        secretRef: 'teams_bot_password:app-0000',
        registration: stubRegistration(input.displayName, input.uniqueName),
        secretKeyId: 'key-0000',
        secretEndDateTime: '2028-01-01T00:00:00Z',
        servicePrincipalOutcome: 'created',
      },
    }),
    deleteAppRegistration: async () => ({ outcome: 'deleted' }),
    getAppRegistration: async () => undefined,
    buildAppPackage: () => new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
    createBot: async (input) => ({
      kind: 'provisioned',
      bot: {
        outcome: 'created',
        value: {
          botName: input.botName,
          resourceId: `/subscriptions/sub/resourceGroups/rg/providers/Microsoft.BotService/botServices/${input.botName}`,
          msaAppId: input.msaAppId,
          messagingEndpoint: input.messagingEndpoint,
        },
      },
    }),
    deleteBot: async () => ({ kind: 'deleted', outcome: 'deleted' }),
    getBot: async () => ({ kind: 'not-found' }),
    uploadToCatalog: async (input) => ({
      outcome: 'created',
      value: {
        teamsAppId: 'catalog-0000',
        externalId: input.externalId,
        displayName: 'Stub Agent',
        version: '1.0.0',
      },
    }),
    getCatalogApp: async () => ({ found: false }),
    installToTeam: async (input) => ({
      outcome: 'created',
      value: {
        teamId: input.teamId,
        teamsAppId: input.teamsAppId,
        installationId: 'install-0000',
      },
    }),
  };

  const merged: TeamsProvisionerAccessor = { ...defaults, ...overrides };

  const record = <A extends readonly unknown[], R>(
    method: keyof TeamsProvisionerAccessor,
    fn: (...args: A) => R,
  ): ((...args: A) => R) => {
    return (...args: A): R => {
      calls.push({ method, args });
      return fn(...args);
    };
  };

  const accessor: TeamsProvisionerAccessor = {
    tenantMode: merged.tenantMode,
    canCreateBots: merged.canCreateBots,
    createAppRegistration: record('createAppRegistration', merged.createAppRegistration),
    deleteAppRegistration: record('deleteAppRegistration', merged.deleteAppRegistration),
    getAppRegistration: record('getAppRegistration', merged.getAppRegistration),
    buildAppPackage: record('buildAppPackage', merged.buildAppPackage),
    createBot: record('createBot', merged.createBot),
    deleteBot: record('deleteBot', merged.deleteBot),
    getBot: record('getBot', merged.getBot),
    uploadToCatalog: record('uploadToCatalog', merged.uploadToCatalog),
    getCatalogApp: record('getCatalogApp', merged.getCatalogApp),
    installToTeam: record('installToTeam', merged.installToTeam),
  };

  return { accessor, calls };
}
