import { ipcMain, dialog, app, BrowserWindow, WebContents } from 'electron';
import {
  CH,
  AppState,
  TestLlmKeyRequest,
  TestLlmKeyResult,
  WizardConfig,
  CompleteResult,
} from './ipcTypes';
import type { BootProgress } from './supervisor';
import { setProviderKey, exportRecoveryKey, isEncryptionAvailable } from './secrets';
import { readSetup, writeSetup } from './setupState';
import { isSetupComplete } from './setupState';
import { setDataDirOverride } from './paths';
import { log } from './log';

const PROVIDER_ENV: Record<WizardConfig['provider'], string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
};

export interface IpcDeps {
  /** Boot the stack with the just-saved config, forwarding progress to the wizard. */
  boot: (forward: (p: BootProgress) => void) => Promise<string>;
  /** Called once the UI is serving so main can swap the wizard for the app window. */
  onReady: (uiUrl: string) => void;
}

export function registerIpc(deps: IpcDeps): void {
  ipcMain.handle(CH.getState, (): AppState => ({
    setupComplete: isSetupComplete(),
    encryptionAvailable: isEncryptionAvailable(),
    version: app.getVersion(),
  }));

  ipcMain.handle(CH.testLlmKey, async (_e, req: TestLlmKeyRequest): Promise<TestLlmKeyResult> => {
    return testLlmKey(req);
  });

  ipcMain.handle(CH.chooseDataDir, async (e): Promise<string | null> => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? undefined;
    const res = await dialog.showOpenDialog(win as BrowserWindow, {
      title: 'Choose where omadia stores its data',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (res.canceled || res.filePaths.length === 0) return null;
    return res.filePaths[0] ?? null;
  });

  ipcMain.handle(CH.exportRecoveryKey, (): string => exportRecoveryKey());

  ipcMain.handle(CH.complete, async (e, config: WizardConfig): Promise<CompleteResult> => {
    try {
      validateConfig(config);

      if (config.dataDir) {
        setDataDirOverride(config.dataDir);
      }
      // Persist the provider key (encrypted) BEFORE writing setup, so a crash
      // between the two never leaves "configured" without a usable key.
      setProviderKey(PROVIDER_ENV[config.provider], config.apiKey.trim());

      // Save config as `configured` but NOT yet `completed`: we only mark the
      // install boot-verified once the stack actually comes up, so a failed
      // first boot doesn't brick the next launch into a dead auto-boot path.
      const setup = readSetup();
      writeSetup({
        ...setup,
        configured: true,
        completed: false,
        llmProvider: config.provider,
        capabilities: config.capabilities,
      });

      const forward = makeProgressForwarder(e.sender);
      const uiUrl = await deps.boot(forward);

      // Boot succeeded — now it's safe to mark the install verified.
      writeSetup({
        ...readSetup(),
        completed: true,
        completedAt: new Date().toISOString(),
      });
      deps.onReady(uiUrl);
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`[ipc] complete failed: ${message}`);
      return { ok: false, error: message };
    }
  });
}

function makeProgressForwarder(sender: WebContents): (p: BootProgress) => void {
  return (p: BootProgress) => {
    if (!sender.isDestroyed()) sender.send(CH.bootProgress, p);
  };
}

function validateConfig(config: WizardConfig): void {
  if (config.provider !== 'anthropic' && config.provider !== 'openai') {
    throw new Error('Unsupported provider.');
  }
  if (!config.apiKey || config.apiKey.trim().length < 8) {
    throw new Error('Please enter a valid API key.');
  }
}

/**
 * Validates an API key by hitting the provider's lightweight `models` endpoint.
 * 2xx → valid, 401/403 → invalid, anything else → surfaced as a soft error so the
 * user can still proceed offline if they insist.
 */
async function testLlmKey(req: TestLlmKeyRequest): Promise<TestLlmKeyResult> {
  const key = req.apiKey.trim();
  if (key.length < 8) return { ok: false, error: 'Key looks too short.' };
  try {
    if (req.provider === 'anthropic') {
      const res = await fetch('https://api.anthropic.com/v1/models?limit=1', {
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        signal: AbortSignal.timeout(10_000),
      });
      return interpret(res.status);
    }
    const res = await fetch('https://api.openai.com/v1/models', {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10_000),
    });
    return interpret(res.status);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Network error' };
  }
}

function interpret(status: number): TestLlmKeyResult {
  if (status >= 200 && status < 300) return { ok: true };
  if (status === 401 || status === 403) return { ok: false, error: 'Key was rejected (unauthorized).' };
  return { ok: false, error: `Unexpected response (HTTP ${status}).` };
}
