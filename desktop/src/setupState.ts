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
  llmProvider: 'anthropic' | 'openai' | 'subscription';
  capabilities: {
    /** in-process embeddings for semantic memory / topic detection */
    embeddings: boolean;
    /** diagram rendering (off by default — kroki is a JVM service, unbundlable) */
    diagrams: boolean;
    /** local-filesystem attachment store */
    attachments: boolean;
  };
  /**
   * The user has actually SEEN their recovery key (OM-58).
   *
   * The wizard's recovery step could be skipped without anyone noticing — a
   * boot finishing mid-setup overwrote the wizard, so the user reached a working
   * app having never been shown the key that decrypts their vault. On a product
   * running a local database that is a silent data-loss risk, so the shell
   * reminds once until this flips.
   *
   * Set only when the key was displayed through the shell's own
   * "Show recovery key" affordance, which is the one place we can observe.
   */
  recoveryKeyShown: boolean;
  /** ISO timestamp of completion, for diagnostics. */
  completedAt?: string;
}

const DEFAULT: SetupState = {
  configured: false,
  completed: false,
  llmProvider: 'anthropic',
  capabilities: { embeddings: false, diagrams: false, attachments: true },
  recoveryKeyShown: false,
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

/** Record that the recovery key was shown, so the reminder stops (OM-58). */
export function markRecoveryKeyShown(): void {
  const setup = readSetup();
  if (setup.recoveryKeyShown) return;
  writeSetup({ ...setup, recoveryKeyShown: true });
}

/**
 * Whether the user still needs to be reminded about the recovery key.
 *
 * Only for a boot-verified install: reminding during first-run setup would fire
 * while the wizard is still on screen offering the key itself.
 */
export function needsRecoveryKeyReminder(): boolean {
  const setup = readSetup();
  return setup.completed && !setup.recoveryKeyShown;
}
