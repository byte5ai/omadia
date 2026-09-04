/**
 * mDNS advertiser must never claim the machine's own host name (OM-70 / #1004).
 *
 * `bonjour-service` defaults the SRV target and the A record it answers for to
 * `os.hostname()`. On macOS that is the same `<LocalHostName>.local` the
 * system's own responder defends, so the OS saw a conflict on every omadia
 * start and renamed the machine. The advertiser now always publishes a distinct
 * host, derived from the instance name and the machine name, or the one the
 * caller passes in.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  MAX_DNS_LABEL_OCTETS,
  deriveAdvertisedHost,
  startMdnsAdvertiser,
  type BonjourLike,
} from '../src/pairing/mdns.js';

/** RFC 1035 label: 1-63 octets of [a-z0-9-], no leading or trailing dash. */
function assertValidLabel(host: string): string {
  assert.ok(host.endsWith('.local'), `${host} must end in .local`);
  const label = host.slice(0, -'.local'.length);
  assert.ok(label.length >= 1 && label.length <= MAX_DNS_LABEL_OCTETS, `${label} is ${label.length} octets`);
  assert.match(label, /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, `${label} is not a valid DNS label`);
  return label;
}

interface Published {
  readonly config: Parameters<BonjourLike['publish']>[0];
}

function fakeResponder(): { readonly published: Published[]; readonly create: () => BonjourLike } {
  const published: Published[] = [];
  const responder: BonjourLike = {
    publish(config) {
      published.push({ config });
      return { on() {} };
    },
    unpublishAll(cb) {
      cb?.();
    },
    destroy() {},
  };
  return { published, create: () => responder };
}

const baseOpts = {
  port: 8769,
  name: 'omadia',
  canvasPath: '/omadia-ui/canvas',
  protocolVersion: '1.0',
  authMode: 'password' as const,
};

test('deriveAdvertisedHost: never equals the machine host name', () => {
  const host = deriveAdvertisedHost('omadia', 'MacBook-Pro-von-Silvio-8.local');
  assert.notEqual(host.toLowerCase(), 'macbook-pro-von-silvio-8.local');
  assert.equal(host, 'omadia-macbook-pro-von-silvio-8.local');
});

test('deriveAdvertisedHost: sanitises the instance name into a DNS label', () => {
  assert.equal(deriveAdvertisedHost('TE Printline / Büro', 'host'), 'te-printline-b-ro-host.local');
  assert.equal(deriveAdvertisedHost('', 'host'), 'omadia-host.local');
  assert.equal(deriveAdvertisedHost('!!!', ''), 'omadia.local');
});

test('deriveAdvertisedHost: caps the label at 63 octets by shortening the machine part', () => {
  const longName = 'te-printline-viernheim-production-instance-number-one';
  const longMachine = 'macbook-pro-von-silvio-lange-mit-einem-sehr-langen-namen-42.local';
  const host = deriveAdvertisedHost(longName, longMachine);
  const label = assertValidLabel(host);
  assert.equal(label.length, MAX_DNS_LABEL_OCTETS);
  assert.ok(label.startsWith(`${longName}-macbook`), 'the instance part is kept whole first');
});

test('deriveAdvertisedHost: no trailing dash when the cut lands on one', () => {
  // 61 chars of instance leaves a budget of 1 for the machine part; the machine
  // label starts with a dash-adjacent cut, so it must be dropped, not kept.
  const instance = 'a'.repeat(61);
  assert.equal(deriveAdvertisedHost(instance, 'x-y'), `${instance}-x.local`);
  assert.equal(deriveAdvertisedHost('a'.repeat(62), 'box'), `${'a'.repeat(62)}.local`);
});

test('deriveAdvertisedHost: an over-long instance name alone is cut to 63 octets', () => {
  const host = deriveAdvertisedHost('b'.repeat(80) + '-tail', 'box');
  const label = assertValidLabel(host);
  assert.equal(label, 'b'.repeat(63));
});

test('deriveAdvertisedHost: strips a trailing .local from the machine name only once', () => {
  assert.equal(deriveAdvertisedHost('x', 'box.local'), 'x-box.local');
  assert.equal(deriveAdvertisedHost('x', 'box'), 'x-box.local');
});

test('startMdnsAdvertiser: publishes the derived host, not the machine host name', async () => {
  const fake = fakeResponder();
  const logs: string[] = [];
  const adv = await startMdnsAdvertiser({
    ...baseOpts,
    createResponder: fake.create,
    machineHostName: 'MacBook-Pro-von-Silvio-8.local',
    log: (m) => logs.push(m),
  });
  assert.equal(fake.published.length, 1);
  const cfg = fake.published[0]!.config;
  assert.equal(cfg.host, 'omadia-macbook-pro-von-silvio-8.local');
  assert.equal(cfg.type, 'omadia');
  assert.equal(cfg.port, 8769);
  assert.ok(
    logs.some((l) => l.includes('host=omadia-macbook-pro-von-silvio-8.local')),
    'the advertised host is logged so a self-hoster can see what was claimed',
  );
  await adv.stop();
});

test('startMdnsAdvertiser: forwards an explicit host verbatim', async () => {
  const fake = fakeResponder();
  await startMdnsAdvertiser({
    ...baseOpts,
    host: 'pairing.example.local',
    createResponder: fake.create,
  });
  assert.equal(fake.published[0]!.config.host, 'pairing.example.local');
});

test('startMdnsAdvertiser: a responder that throws yields an inert handle', async () => {
  const adv = await startMdnsAdvertiser({
    ...baseOpts,
    createResponder: () => {
      throw new Error('no multicast');
    },
  });
  await adv.stop();
});
