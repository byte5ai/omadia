/** Shared IPC channel names + payload types between main and the wizard renderer. */

export const CH = {
  getState: 'omadia:getState',
  testLlmKey: 'omadia:testLlmKey',
  chooseDataDir: 'omadia:chooseDataDir',
  complete: 'omadia:complete',
  exportRecoveryKey: 'omadia:exportRecoveryKey',
  bootProgress: 'omadia:bootProgress',
  bootLog: 'omadia:bootLog',
  /** OM-71: renderer → main, "the first real screen is standing". */
  uiReady: 'omadia:uiReady',
} as const;

/** A single line streamed to the wizard/loading UI during boot. */
export interface BootLogLine {
  level: 'INFO' | 'WARN' | 'ERROR';
  msg: string;
}

export interface AppState {
  setupComplete: boolean;
  encryptionAvailable: boolean;
  version: string;
}

export type ApiKeyProvider = 'anthropic' | 'openai';

export interface TestLlmKeyRequest {
  provider: ApiKeyProvider;
  apiKey: string;
}

export interface TestLlmKeyResult {
  ok: boolean;
  error?: string;
}

export interface WizardConfig {
  /** `subscription` stores no API key; Claude/Codex CLI is connected after boot. */
  provider: ApiKeyProvider | 'subscription';
  apiKey: string;
  capabilities: {
    embeddings: boolean;
    diagrams: boolean;
    attachments: boolean;
  };
  /** Optional custom data directory; null = use the default userData location. */
  dataDir: string | null;
}

export interface CompleteResult {
  ok: boolean;
  error?: string;
}
