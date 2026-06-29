import fs from 'node:fs';
import { setupFile } from './paths';

/**
 * Non-secret first-run configuration. Secrets (vault key, provider API keys) live
 * in `secrets.ts` (OS-keychain encrypted) — never here.
 */
export interface SetupState {
  /** The wizard was filled in and config + keys were saved. */
  configured: boolean;
  /** The stack has booted successfully at least once (boot-verified). */
  completed: boolean;
  llmProvider: 'anthropic' | 'openai';
  capabilities: {
    /** in-process embeddings for semantic memory / topic detection */
    embeddings: boolean;
    /** diagram rendering (off by default — kroki is a JVM service, unbundlable) */
    diagrams: boolean;
    /** local-filesystem attachment store */
    attachments: boolean;
  };
  /** ISO timestamp of completion, for diagnostics. */
  completedAt?: string;
}

const DEFAULT: SetupState = {
  configured: false,
  completed: false,
  llmProvider: 'anthropic',
  capabilities: { embeddings: false, diagrams: false, attachments: true },
};

export function readSetup(): SetupState {
  try {
    const raw = fs.readFileSync(setupFile(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<SetupState>;
    return {
      ...DEFAULT,
      ...parsed,
      capabilities: { ...DEFAULT.capabilities, ...(parsed.capabilities ?? {}) },
    };
  } catch {
    return { ...DEFAULT };
  }
}

export function writeSetup(state: SetupState): void {
  fs.writeFileSync(setupFile(), JSON.stringify(state, null, 2), 'utf8');
}

export function isSetupComplete(): boolean {
  return readSetup().completed;
}
