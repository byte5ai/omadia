#!/usr/bin/env tsx
/**
 * One-shot: install a 90-day expiration rule on the Tigris (or local MinIO)
 * diagrams bucket.
 *
 * Runs against whatever S3 endpoint the standard Tigris env vars point at:
 *   BUCKET_NAME, AWS_ENDPOINT_URL_S3, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
 *
 * Idempotent: the PutBucketLifecycleConfiguration replaces the rule set
 * completely, so re-running is safe.
 *
 * Production usage (from any machine with `flyctl` + the repo):
 *   fly ssh console -a odoo-bot-middleware \
 *     -C 'sh -c "cd /app && node dist/scripts/setup-tigris-lifecycle.js"'
 *
 * Local (against compose.yml's MinIO — already provisioned by minio-init):
 *   cd middleware && npx tsx scripts/setup-tigris-lifecycle.ts
 */
import {
  GetBucketLifecycleConfigurationCommand,
  PutBucketLifecycleConfigurationCommand,
  S3Client,
} from '@aws-sdk/client-s3';

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.length === 0) {
    throw new Error(`${name} must be set`);
  }
  return v;
}

async function main(): Promise<void> {
  const bucket = requireEnv('BUCKET_NAME');
  const client = new S3Client({
    region: 'auto',
    endpoint: requireEnv('AWS_ENDPOINT_URL_S3'),
    credentials: {
      accessKeyId: requireEnv('AWS_ACCESS_KEY_ID'),
      secretAccessKey: requireEnv('AWS_SECRET_ACCESS_KEY'),
    },
    forcePathStyle: true,
  });

  console.log(`[tigris-lifecycle] target bucket: ${bucket}`);

  await client.send(
    new PutBucketLifecycleConfigurationCommand({
      Bucket: bucket,
      LifecycleConfiguration: {
        // Tigris allows exactly one rule per bucket; this one mirrors the
        // local minio-init so dev + prod share semantics.
        Rules: [
          {
            ID: 'expire-90d',
            Status: 'Enabled',
            Filter: { Prefix: '' },
            Expiration: { Days: 90 },
          },
        ],
      },
    }),
  );
  console.log('[tigris-lifecycle] PUT ok — verifying…');

  const current = await client.send(
    new GetBucketLifecycleConfigurationCommand({ Bucket: bucket }),
  );
  for (const rule of current.Rules ?? []) {
    console.log(
      `[tigris-lifecycle]  rule id=${rule.ID ?? '?'} status=${rule.Status ?? '?'} days=${String(rule.Expiration?.Days ?? '?')}`,
    );
  }
  console.log('[tigris-lifecycle] done.');
}

main().catch((err) => {
  console.error('[tigris-lifecycle] FAILED:', err);
  process.exit(1);
});
