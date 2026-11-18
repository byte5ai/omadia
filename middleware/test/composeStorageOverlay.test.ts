/**
 * The storage overlay (#1506), checked on the compose file itself.
 *
 * `minio/minio` and `minio/mc` disappeared from Docker Hub and the overlay
 * stopped pulling on every fresh install. This suite pins what the fix relies
 * on: no MinIO image, every image on a version tag (a `latest` that vanishes
 * or changes shape fails silently), and one set of credentials shared by the
 * S3 server, the bucket-init step and the middleware, so a rename in one place
 * cannot leave the kernel unable to sign requests.
 *
 * Whether the pinned images still EXIST upstream is checked in CI with
 * `docker manifest inspect`; a parse cannot tell.
 */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';

const OVERLAY = fileURLToPath(new URL('../../docker-compose.storage.yaml', import.meta.url));

type YamlMap = Readonly<Record<string, unknown>>;

function asMap(value: unknown, label: string): YamlMap {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), `${label} is a map`);
  return value as YamlMap;
}

const doc = asMap(parse(readFileSync(OVERLAY, 'utf8')), 'overlay');
const services = asMap(doc['services'], 'services');
const service = (name: string): YamlMap => asMap(services[name], `services.${name}`);
const env = (name: string): YamlMap => asMap(service(name)['environment'], `services.${name}.environment`);

describe('docker-compose.storage.yaml (#1506)', () => {
  it('uses no MinIO image', () => {
    for (const [name, raw] of Object.entries(services)) {
      const image = asMap(raw, name)['image'];
      if (typeof image === 'string') {
        assert.doesNotMatch(image, /minio/i, `services.${name} still pulls ${image}`);
      }
    }
  });

  it('pins every image to an explicit, non-latest tag', () => {
    for (const name of ['s3', 's3-init']) {
      const image = service(name)['image'];
      assert.equal(typeof image, 'string', `services.${name}.image`);
      assert.match(image as string, /^[^:]+:[0-9][\w.-]*$/, `services.${name} pins a version: ${String(image)}`);
    }
  });

  it('points the middleware at the in-network S3 service', () => {
    const mw = env('middleware');
    assert.equal(mw['AWS_ENDPOINT_URL_S3'], 'http://s3:9000');
    assert.equal(mw['BUCKET_NAME'], 'diagrams');
    assert.deepEqual(asMap(service('middleware')['depends_on'], 'middleware.depends_on')['s3-init'], {
      condition: 'service_completed_successfully',
    });
  });

  it('shares one credential pair between server, init step and middleware', () => {
    const [mw, server, init] = [env('middleware'), env('s3'), env('s3-init')];
    for (const key of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY']) {
      assert.equal(typeof mw[key], 'string', `middleware.${key}`);
      assert.equal(server[key], mw[key], `s3.${key} matches middleware`);
      assert.equal(init[key], mw[key], `s3-init.${key} matches middleware`);
    }
  });

  it('provisions the bucket the middleware uses, with the 90-day rule', () => {
    const script = (service('s3-init')['entrypoint'] as unknown[]).join('\n');
    assert.match(script, /create-bucket --bucket diagrams/);
    assert.match(script, /"Expiration":\{"Days":90\}/);
    assert.equal(env('s3-init')['AWS_ENDPOINT_URL'], 'http://s3:9000');
  });

  it('exposes the S3 port on loopback only', () => {
    assert.deepEqual(service('s3')['ports'], ['127.0.0.1:9000:9000']);
  });
});
