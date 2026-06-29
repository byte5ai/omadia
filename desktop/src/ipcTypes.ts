/** Shared IPC channel names + payload types between main and the wizard renderer. */

export const CH = {
  getState: 'omadia:getState',
  testLlmKey: 'omadia:testLlmKey',
  chooseDataDir: 'omadia:chooseDataDir',
  complete: 'omadia:complete',
  exportRecoveryKey: 'omadia:exportRecoveryKey',
  bootProgress: 'omadia:bootProgress',
  bootLog: 'omadia:bootLog',
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

export interface TestLlmKeyRequest {
  provider: 'anthropic' | 'openai';
  apiKey: string;
}

export interface TestLlmKeyResult {
  ok: boolean;
  error?: string;
}

export interface WizardConfig {
  provider: 'anthropic' | 'openai';
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
