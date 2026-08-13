import type { DevPlatformConfig } from '../../src/devplatform/config.js';

/**
 * Build a `DevPlatformConfig` for a wire test.
 *
 * The assembly takes ONE config object (epic #470 C3) instead of ~20 loose
 * fields, so a test that used to spread its settings across the deps literal now
 * passes `config: devPlatformTestConfig({ ... })`.
 *
 * The values here are NOT copies of the production zod defaults — they are the
 * inert values the wire tests always used, kept in one place so a new field on
 * the interface does not have to be added to four call sites. Anything a test
 * actually asserts on must be passed explicitly as an override.
 */
export function devPlatformTestConfig(
  over: Partial<DevPlatformConfig> & Pick<DevPlatformConfig, 'baseUrl'>,
): DevPlatformConfig {
  return {
    enabled: true,
    cliBin: 'claude',
    wallClockMs: 600_000,
    heartbeatTimeoutMs: 600_000,
    maxConcurrentJobs: 1,
    commitAuthor: 'omadia-dev <dev-platform@omadia.ai>',
    subscriptionModeEnabled: false,
    workspaceDir: '/tmp/dev-platform-test',
    unsafeLocal: false,
    backend: 'docker',
    // Read only by the mount site in index.ts, never by the assembly — present so
    // the object satisfies the interface.
    webhooks: { enabled: false, maxJobsPerRepoHour: 5, maxJobsPerSenderHour: 2 },
    retention: {
      eventRetentionDays: 30,
      auditRetentionDays: 365,
      maxEventsPerJob: 50_000,
      artifactMaxBytes: 5 * 1024 * 1024,
    },
    ...over,
  };
}
