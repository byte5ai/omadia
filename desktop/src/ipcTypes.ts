/**
 * Shared IPC channel names + payload types between main and the renderer
 * pages. Which document may use which channel is decided per call in
 * `ipcSender.ts` (setup channels: the bundled wizard; UI pings: the web UI).
 */

export const CH = {
  testLlmKey: 'omadia:testLlmKey',
  chooseDataDir: 'omadia:chooseDataDir',
  complete: 'omadia:complete',
  exportRecoveryKey: 'omadia:exportRecoveryKey',
  bootProgress: 'omadia:bootProgress',
  bootLog: 'omadia:bootLog',
  /** OM-71: renderer → main, "the first real screen is standing". */
  uiReady: 'omadia:uiReady',
  /** #1074: renderer → main, "this is the language I am showing" (`'en'` | `'de'`). */
  uiLocale: 'omadia:uiLocale',
} as const;

/** A single line streamed to the wizard/loading UI during boot. */
export interface BootLogLine {
  level: 'INFO' | 'WARN' | 'ERROR';
  msg: string;
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
