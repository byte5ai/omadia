import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  buildCreateConfig,
  containerName,
  splitImageRef,
} from '../src/recreate.mjs';

describe('splitImageRef', () => {
  it('splits a normal repo:tag', () => {
    assert.deepEqual(splitImageRef('ghcr.io/byte5ai/omadia-middleware:v0.74.0'), {
      repo: 'ghcr.io/byte5ai/omadia-middleware',
      tag: 'v0.74.0',
      digest: null,
    });
  });

  it('does not mistake a registry port for a tag', () => {
    assert.deepEqual(splitImageRef('registry.local:5000/omadia/middleware'), {
      repo: 'registry.local:5000/omadia/middleware',
      tag: null,
      digest: null,
    });
  });

  it('handles a digest pin', () => {
    assert.deepEqual(splitImageRef('ghcr.io/x/y@sha256:abc'), {
      repo: 'ghcr.io/x/y',
      tag: null,
      digest: 'sha256:abc',
    });
  });

  // The regression behind `repo:v0.136.2:v0.140.1 is not available`: Fly
  // reports a machine's image with BOTH a tag and a digest, and returning the
  // tagged part as the repository made the caller append a second tag.
  it('strips the tag when a digest is also present', () => {
    assert.deepEqual(
      splitImageRef('ghcr.io/byte5ai/omadia-middleware:v0.136.2@sha256:abc'),
      {
        repo: 'ghcr.io/byte5ai/omadia-middleware',
        tag: 'v0.136.2',
        digest: 'sha256:abc',
      },
    );
  });

  it('keeps a registry port intact alongside a digest', () => {
    assert.deepEqual(splitImageRef('registry.local:5000/omadia/mw@sha256:abc'), {
      repo: 'registry.local:5000/omadia/mw',
      tag: null,
      digest: 'sha256:abc',
    });
  });

  it('handles a bare repo', () => {
    assert.deepEqual(splitImageRef('postgres'), {
      repo: 'postgres',
      tag: null,
      digest: null,
    });
  });
});

describe('buildCreateConfig', () => {
  const inspect = {
    Id: 'c1',
    Name: '/omadia-middleware-1',
    Config: {
      Image: 'ghcr.io/byte5ai/omadia-middleware:v0.74.0',
      Env: ['NODE_ENV=production', 'OMADIA_VERSION=v0.74.0', 'VAULT_KEY=s3cret'],
      Labels: { 'com.docker.compose.service': 'middleware' },
      Hostname: 'middleware',
      ExposedPorts: { '8080/tcp': {} },
    },
    HostConfig: {
      RestartPolicy: { Name: 'unless-stopped' },
      Binds: ['middleware-data:/data'],
    },
    NetworkSettings: {
      Networks: {
        omadia_omadia: { Aliases: ['middleware'], IPAMConfig: null },
        extra_net: { Aliases: ['mw'] },
      },
    },
  };

  it('drops the stale OMADIA_VERSION so the new image stamp wins', () => {
    const { config } = buildCreateConfig(inspect, 'ghcr.io/byte5ai/omadia-middleware:v0.75.0');

    assert.ok(
      !config.Env.some((entry) => entry.startsWith('OMADIA_VERSION=')),
      'the old build stamp must not be carried into the new container — the health gate reads it',
    );
    // Everything else survives untouched.
    assert.ok(config.Env.includes('NODE_ENV=production'));
    assert.ok(config.Env.includes('VAULT_KEY=s3cret'));
  });

  it('retargets only the image and preserves compose identity', () => {
    const { config } = buildCreateConfig(inspect, 'ghcr.io/byte5ai/omadia-middleware:v0.75.0');

    assert.equal(config.Image, 'ghcr.io/byte5ai/omadia-middleware:v0.75.0');
    assert.deepEqual(config.Labels, { 'com.docker.compose.service': 'middleware' });
    assert.deepEqual(config.HostConfig, inspect.HostConfig);
    assert.deepEqual(config.ExposedPorts, { '8080/tcp': {} });
  });

  it('passes the first network at create time and returns the rest to connect', () => {
    const { config, extraNetworks } = buildCreateConfig(inspect, 'img:2');

    assert.deepEqual(
      Object.keys(config.NetworkingConfig.EndpointsConfig),
      ['omadia_omadia'],
      'the Engine API accepts a single endpoint at create time',
    );
    assert.deepEqual(config.NetworkingConfig.EndpointsConfig.omadia_omadia.Aliases, [
      'middleware',
    ]);
    assert.deepEqual(extraNetworks, [
      { name: 'extra_net', endpoint: { Aliases: ['mw'], IPAMConfig: undefined } },
    ]);
  });

  it('survives a container with no networks at all', () => {
    const { config, extraNetworks } = buildCreateConfig(
      { Config: { Env: [] }, NetworkSettings: {} },
      'img:1',
    );
    assert.equal(config.NetworkingConfig, undefined);
    assert.deepEqual(extraNetworks, []);
  });
});

describe('containerName', () => {
  it('strips the leading slash docker reports', () => {
    assert.equal(containerName({ Name: '/omadia-middleware-1' }), 'omadia-middleware-1');
    assert.equal(containerName({}), '');
  });
});
