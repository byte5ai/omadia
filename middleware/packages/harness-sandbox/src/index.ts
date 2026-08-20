export type {
  AgentComputerProfile,
} from './agentComputerProfile.js';
export {
  DEFAULT_AGENT_COMPUTER_PROFILE,
  resolveAgentComputerProfile,
} from './agentComputerProfile.js';

export type { PathGuardOutcome } from './pathGuard.js';
export { clampSandboxPath, clampSandboxPathPosix } from './pathGuard.js';

export type {
  Sandbox,
  SandboxBackend,
  SandboxRunOptions,
  SandboxRunResult,
  SandboxReadOutcome,
  SandboxWriteOutcome,
  SandboxListOutcome,
  SandboxListEntry,
  SandboxCapability,
  ProcessSessionCapableSandbox,
  BackupCapableSandbox,
  BlobStagingCapableSandbox,
} from './sandbox.js';
export { hasProcessSessions, hasBackup, hasBlobStaging } from './sandbox.js';

export type { DockerExec, DockerExecContext, DockerExecResult } from './dockerExec.js';
export { execDockerViaSpawn } from './dockerExec.js';

export type { DockerSandboxBackendOptions } from './dockerSandbox.js';
export { DockerSandboxBackend } from './dockerSandbox.js';
