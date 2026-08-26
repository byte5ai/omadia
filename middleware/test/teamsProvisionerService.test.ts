/**
 * Tests for the `teamsProvisioner@1` choke point
 * (`middleware/src/platform/teamsProvisionerService.ts`, wave W1a,
 * epic byte5ai/omadia#860).
 *
 * The connector plugin is not vendored in this checkout, so everything runs
 * against `createStubTeamsProvisioner` (test/_helpers), which implements the
 * mirrored accessor interface — the same stub the router and job-runner
 * suites drive.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { perCallerService, type ServiceCaller } from '@omadia/plugin-api';

import { ServiceRegistry } from '../src/platform/serviceRegistry.js';
import {
  buildTeamsBotMessagingEndpoint,
  getTeamsProvisioner,
  isArmNotConfiguredError,
  isConsentMissingError,
  isProvisioningThrottledError,
  isTeamsProvisionerError,
  requireTeamsProvisioner,
  SingleTenantViolationError,
  TEAMS_PROVISIONER_SERVICE_NAME,
  TeamsMessagingEndpointError,
  TeamsProvisionerUnavailableError,
  type CreateAppRegistrationInput,
  type TeamsProvisionerAccessor,
} from '../src/platform/teamsProvisionerService.js';
import { createStubTeamsProvisioner } from './_helpers/stubTeamsProvisioner.js';

function registryWith(accessor: TeamsProvisionerAccessor): ServiceRegistry {
  const registry = new ServiceRegistry();
  registry.provide(TEAMS_PROVISIONER_SERVICE_NAME, accessor, '@omadia/integration-microsoft365');
  return registry;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

describe('teamsProvisioner resolution', () => {
  it('returns undefined when the connector plugin is not installed', () => {
    assert.equal(getTeamsProvisioner(new ServiceRegistry()), undefined);
  });

  it('requireTeamsProvisioner throws the typed unavailable error (router → 503), never crashes', () => {
    assert.throws(
      () => requireTeamsProvisioner(new ServiceRegistry()),
      (err: unknown) => {
        assert.ok(err instanceof TeamsProvisionerUnavailableError);
        assert.equal(err.code, 'teams_provisioner_unavailable');
        assert.match(err.message, /teamsProvisioner@1 is not published/);
        assert.match(err.message, /@omadia\/integration-microsoft365/);
        return true;
      },
    );
  });

  it('resolves a registered provider and passes calls through', async () => {
    const stub = createStubTeamsProvisioner();
    const provisioner = requireTeamsProvisioner(registryWith(stub.accessor));

    assert.equal(provisioner.tenantMode, 'customer');
    assert.equal(provisioner.canCreateBots, true);

    const uploaded = await provisioner.uploadToCatalog({
      packageZip: new Uint8Array([1]),
      externalId: 'ext-1',
    });
    assert.equal(uploaded.outcome, 'created');
    assert.equal(uploaded.value.externalId, 'ext-1');

    const lookup = await provisioner.getCatalogApp({ teamsAppExternalId: 'ext-1' });
    assert.deepEqual(lookup, { found: false });

    assert.deepEqual(
      stub.calls.map((call) => call.method),
      ['uploadToCatalog', 'getCatalogApp'],
    );
  });

  it('resolves per-caller registrations as the kernel, not a fabricated plugin', () => {
    const stub = createStubTeamsProvisioner();
    const seen: ServiceCaller[] = [];
    const registry = new ServiceRegistry();
    registry.provide(
      TEAMS_PROVISIONER_SERVICE_NAME,
      perCallerService((caller) => {
        seen.push(caller);
        return stub.accessor;
      }),
    );

    const provisioner = getTeamsProvisioner(registry);
    assert.notEqual(provisioner, undefined);
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.agentId, '@omadia/core');
    assert.equal(seen[0]?.pluginId, '@omadia/core');
  });

  it('duplicate providers stay a registry-level error (operator must uninstall one)', () => {
    const registry = registryWith(createStubTeamsProvisioner().accessor);
    assert.throws(
      () =>
        registry.provide(
          TEAMS_PROVISIONER_SERVICE_NAME,
          createStubTeamsProvisioner().accessor,
        ),
      /duplicate provider for 'teamsProvisioner'/,
    );
  });
});

// ---------------------------------------------------------------------------
// SingleTenant boundary guard
// ---------------------------------------------------------------------------

describe('single-tenant guard', () => {
  it('accepts customer/home tenant modes on createAppRegistration', async () => {
    const stub = createStubTeamsProvisioner();
    const provisioner = requireTeamsProvisioner(registryWith(stub.accessor));

    for (const tenantMode of ['customer', 'home'] as const) {
      const result = await provisioner.createAppRegistration({
        displayName: 'HR Agent',
        tenantMode,
        uniqueName: 'omadia-hr-agent',
      });
      assert.equal(result.value.registration.signInAudience, 'AzureADMyOrg');
    }
    assert.equal(stub.calls.length, 2);
  });

  it('rejects unknown tenant modes before the connector sees them', async () => {
    const stub = createStubTeamsProvisioner();
    const provisioner = requireTeamsProvisioner(registryWith(stub.accessor));

    const multiTenant = {
      displayName: 'Rogue',
      tenantMode: 'multiTenant',
    } as unknown as CreateAppRegistrationInput;

    await assert.rejects(
      () => provisioner.createAppRegistration(multiTenant),
      (err: unknown) => {
        assert.ok(err instanceof SingleTenantViolationError);
        assert.equal(err.code, 'single_tenant_only');
        assert.equal(err.field, 'tenantMode');
        return true;
      },
    );
    assert.equal(stub.calls.length, 0, 'the connector must never see the input');
  });

  it('rejects a smuggled non-single-tenant signInAudience', async () => {
    const stub = createStubTeamsProvisioner();
    const provisioner = requireTeamsProvisioner(registryWith(stub.accessor));

    const smuggled = {
      displayName: 'Rogue',
      tenantMode: 'customer',
      signInAudience: 'AzureADMultipleOrgs',
    } as unknown as CreateAppRegistrationInput;

    await assert.rejects(
      () => provisioner.createAppRegistration(smuggled),
      (err: unknown) =>
        err instanceof SingleTenantViolationError && err.field === 'signInAudience',
    );
    assert.equal(stub.calls.length, 0);
  });

  it('guards getAppRegistration tenant-mode probes too', async () => {
    const stub = createStubTeamsProvisioner();
    const provisioner = requireTeamsProvisioner(registryWith(stub.accessor));

    await assert.rejects(
      () =>
        provisioner.getAppRegistration('app-1', 'AzureADMultipleOrgs' as never),
      SingleTenantViolationError,
    );
    assert.equal(await provisioner.getAppRegistration('app-1', 'customer'), undefined);
    assert.equal(stub.calls.length, 1);
  });
});

// ---------------------------------------------------------------------------
// Secret custody
// ---------------------------------------------------------------------------

describe('secret custody', () => {
  it('passes through the contract shape: opaque secretRef, no cleartext', async () => {
    const provisioner = requireTeamsProvisioner(
      registryWith(createStubTeamsProvisioner().accessor),
    );
    const result = await provisioner.createAppRegistration({
      displayName: 'HR Agent',
      tenantMode: 'customer',
    });
    assert.equal(result.value.secretRef, 'teams_bot_password:app-0000');
    assert.ok(!('secretText' in result.value));
  });

  it('strips cleartext-looking fields a mis-implemented provider attaches', async () => {
    const stub = createStubTeamsProvisioner({
      createAppRegistration: async (input) => ({
        outcome: 'created',
        value: {
          appId: 'app-9',
          secretRef: 'teams_bot_password:app-9',
          registration: {
            appId: 'app-9',
            objectId: 'obj-9',
            tenantId: 't-9',
            tenantMode: 'customer',
            signInAudience: 'AzureADMyOrg',
            displayName: input.displayName,
          },
          secretKeyId: 'key-9',
          secretEndDateTime: '2028-01-01T00:00:00Z',
          servicePrincipalOutcome: 'created',
          // A provider bug leaking the cleartext across the boundary:
          secretText: 'S3CR3T-value',
          clientSecret: 'S3CR3T-value',
        } as never,
      }),
    });
    const provisioner = requireTeamsProvisioner(registryWith(stub.accessor));

    const result = await provisioner.createAppRegistration({
      displayName: 'Leaky',
      tenantMode: 'customer',
    });

    assert.ok(!('secretText' in result.value));
    assert.ok(!('clientSecret' in result.value));
    assert.ok(!JSON.stringify(result).includes('S3CR3T-value'));
    // The legitimate fields survive the strip.
    assert.equal(result.value.appId, 'app-9');
    assert.equal(result.value.secretRef, 'teams_bot_password:app-9');
  });
});

// ---------------------------------------------------------------------------
// Typed-error guards (duck-typed across the plugin boundary)
// ---------------------------------------------------------------------------

function connectorError(
  name: string,
  fields: Record<string, unknown>,
): Error {
  const err = new Error(name);
  err.name = name;
  Object.assign(err, fields);
  return err;
}

describe('connector error guards', () => {
  it('recognises ConsentMissingError by name + structured fields', () => {
    const err = connectorError('ConsentMissingError', {
      missingScopes: ['Application.ReadWrite.OwnedBy'],
      resource: 'graph',
    });
    assert.equal(isConsentMissingError(err), true);
    if (isConsentMissingError(err)) {
      assert.deepEqual(err.missingScopes, ['Application.ReadWrite.OwnedBy']);
    }
    assert.equal(isConsentMissingError(new Error('ConsentMissingError')), false);
    assert.equal(isConsentMissingError(undefined), false);
  });

  it('recognises ProvisioningThrottledError with and without a retry hint', () => {
    const withHint = connectorError('ProvisioningThrottledError', {
      resource: 'arm',
      retryAfterSeconds: 42,
    });
    const withoutHint = connectorError('ProvisioningThrottledError', {
      resource: 'graph',
    });
    assert.equal(isProvisioningThrottledError(withHint), true);
    if (isProvisioningThrottledError(withHint)) {
      assert.equal(withHint.retryAfterSeconds, 42);
    }
    assert.equal(isProvisioningThrottledError(withoutHint), true);
    assert.equal(isProvisioningThrottledError(new Error('other')), false);
  });

  it('recognises ArmNotConfiguredError and its missing setup fields', () => {
    const err = connectorError('ArmNotConfiguredError', {
      missingSetupFields: ['azure_subscription_id'],
    });
    assert.equal(isArmNotConfiguredError(err), true);
    assert.equal(
      isArmNotConfiguredError(connectorError('ArmNotConfiguredError', {})),
      false,
    );
  });

  it('isTeamsProvisionerError covers the taxonomy, nothing else', () => {
    for (const name of [
      'ConsentMissingError',
      'ProvisioningThrottledError',
      'ArmNotConfiguredError',
      'CapabilityUnavailableError',
      'AppPackageError',
    ]) {
      assert.equal(isTeamsProvisionerError(connectorError(name, {})), true, name);
    }
    assert.equal(isTeamsProvisionerError(new Error('boom')), false);
    assert.equal(isTeamsProvisionerError('ConsentMissingError'), false);
  });
});

// ---------------------------------------------------------------------------
// Messaging endpoint URL builder
// ---------------------------------------------------------------------------

describe('buildTeamsBotMessagingEndpoint', () => {
  it('builds the per-bot endpoint shipped in channel-teams 0.20.0', () => {
    assert.equal(
      buildTeamsBotMessagingEndpoint('https://bots.example.com', 'hr-agent'),
      'https://bots.example.com/api/teams/hr-agent/messages',
    );
  });

  it('normalises trailing slashes on the base', () => {
    for (const base of [
      'https://bots.example.com/',
      'https://bots.example.com//',
    ]) {
      assert.equal(
        buildTeamsBotMessagingEndpoint(base, 'hr-agent'),
        'https://bots.example.com/api/teams/hr-agent/messages',
      );
    }
  });

  it('keeps a base path prefix intact', () => {
    assert.equal(
      buildTeamsBotMessagingEndpoint('https://example.com/omadia/', 'hr-agent'),
      'https://example.com/omadia/api/teams/hr-agent/messages',
    );
  });

  it('rejects non-https bases — the value is handed to Azure as the bot endpoint', () => {
    for (const base of ['http://bots.example.com', 'ftp://bots.example.com']) {
      assert.throws(
        () => buildTeamsBotMessagingEndpoint(base, 'hr-agent'),
        (err: unknown) => {
          assert.ok(err instanceof TeamsMessagingEndpointError);
          assert.equal(err.code, 'invalid_teams_messaging_endpoint');
          assert.match(err.message, /https/);
          return true;
        },
      );
    }
  });

  it('rejects malformed bases, credentials, query strings and fragments', () => {
    for (const base of [
      'not a url',
      'https://user:pw@bots.example.com',
      'https://bots.example.com?x=1',
      'https://bots.example.com#frag',
    ]) {
      assert.throws(
        () => buildTeamsBotMessagingEndpoint(base, 'hr-agent'),
        TeamsMessagingEndpointError,
      );
    }
  });

  it('rejects slugs that could re-shape the path', () => {
    for (const slug of ['', 'a/b', '../up', 'a b', 'a?b', '.hidden', 'x'.repeat(65)]) {
      assert.throws(
        () => buildTeamsBotMessagingEndpoint('https://bots.example.com', slug),
        TeamsMessagingEndpointError,
        JSON.stringify(slug),
      );
    }
  });

  it('accepts dots, underscores and hyphens inside a slug', () => {
    assert.equal(
      buildTeamsBotMessagingEndpoint('https://bots.example.com', 'Agent_2.beta-1'),
      'https://bots.example.com/api/teams/Agent_2.beta-1/messages',
    );
  });
});
