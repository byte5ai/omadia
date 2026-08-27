import { ipcMain, dialog, app, BrowserWindow, WebContents } from 'electron';
import {
  CH,
  ApiKeyProvider,
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

const PROVIDER_ENV: Record<ApiKeyProvider, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
};

export interface IpcDeps {
  /** Boot the stack with the just-saved config, forwarding progress to the wizard. */
  boot: (forward: (p: BootProgress) => void) => Promise<string>;
  /** Called once the UI is serving so main can swap the wizard for the app window. */
  onReady: (uiUrl: string) => void;
}

/**
 * Whether this provider needs an API key stored and validated.
 *
 * `subscription` runs on an existing Claude/Codex CLI login, so there is no key
 * to enter, probe, or persist. A type predicate rather than a plain boolean so
 * the true branch narrows to the providers `PROVIDER_ENV` actually has an entry
 * for — the lookup can then never be reached with an unmapped provider.
 */
export function requiresApiKey(provider: WizardConfig['provider']): provider is ApiKeyProvider {
  return provider !== 'subscription';
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
      // between the two never leaves "configured" without a usable key. A
      // subscription setup has no key to persist: the kernel boots without one
      // (both provider vars are optional in the middleware config schema and
      // `/health` never reads them), and the CLI login is connected after boot.
      if (requiresApiKey(config.provider)) {
        setProviderKey(PROVIDER_ENV[config.provider], config.apiKey.trim());
      }

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
  if (
    config.provider !== 'anthropic' &&
    config.provider !== 'openai' &&
    config.provider !== 'subscription'
  ) {
    throw new Error('Unsupported provider.');
  }
  if (requiresApiKey(config.provider) && (!config.apiKey || config.apiKey.trim().length < 8)) {
    throw new Error('Please enter a valid API key.');
  }
}

/** A model list is a few KB at most; anything past this is not one. */
const MAX_PROBE_BODY_BYTES = 64 * 1024;

/**
 * Validates an API key by hitting the provider's lightweight `models` endpoint.
 * A 2xx only counts when it carries a JSON model list; 401 (and a 403 that
 * self-identifies as an authentication error) means the key was rejected; every
 * other outcome is surfaced as a soft error so the user can still proceed
 * offline if they insist.
 *
 * PRE-BOOT TWIN of `middleware/src/platform/providerCredentialVerifier.ts`. This
 * runs in the Electron main process before the middleware exists, so it cannot
 * import that module (separate builds — sharing it would need a new package).
 * The two are therefore deliberately kept identical in behaviour: same
 * endpoints, same headers, same 10 s timeout, the same refusal to follow a
 * redirect (`x-api-key` is a custom header, so the Fetch spec would forward it
 * across origins), the same "a 2xx must look like a model list" gate, and the
 * same non-negotiable mapping where a bare 403 is a permission/region block
 * rather than a bad key and everything else (5xx, network, timeout) is
 * inconclusive rather than a rejection. Change one, change the other.
 */
async function testLlmKey(req: TestLlmKeyRequest): Promise<TestLlmKeyResult> {
  const key = req.apiKey.trim();
  if (key.length < 8) return { ok: false, error: 'Key looks too short.' };
  try {
    // One signal for the request AND the bounded body read below.
    const signal = AbortSignal.timeout(10_000);
    const res =
      req.provider === 'anthropic'
        ? await fetch('https://api.anthropic.com/v1/models?limit=1', {
            headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
            redirect: 'error',
            signal,
          })
        : await fetch('https://api.openai.com/v1/models', {
            headers: { Authorization: `Bearer ${key}` },
            redirect: 'error',
            signal,
          });
    return await interpret(res, signal);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Network error' };
  }
}

async function interpret(res: Response, signal: AbortSignal): Promise<TestLlmKeyResult> {
  if (res.status >= 200 && res.status < 300) {
    // A captive portal or corporate proxy answers 200 text/html for a blocked
    // host — treating that as a valid key is how a bogus credential got through.
    if (!isJsonContentType(res.headers.get('content-type'))) {
      return { ok: false, error: 'The response did not come from the provider (not JSON). Check any proxy or firewall.' };
    }
    const body = await readBoundedBody(res, signal);
    if (body === undefined || !looksLikeModelList(body)) {
      return { ok: false, error: 'Unexpected response body from the provider.' };
    }
    return { ok: true };
  }
  if (res.status === 401) return { ok: false, error: 'Key was rejected (unauthorized).' };
  if (res.status === 403) {
    const body = await readBoundedBody(res, signal);
    if (body !== undefined && /"type"\s*:\s*"(authentication_error|invalid_api_key)"/.test(body)) {
      return { ok: false, error: 'Key was rejected (unauthorized).' };
    }
    // OpenAI answers 403 for "Country, region, or territory not supported" and
    // Anthropic for org-permission blocks — neither means a wrong key.
    return { ok: false, error: 'The provider refused the request (HTTP 403). This usually means a permission or region restriction, not a wrong key.' };
  }
  return { ok: false, error: `Unexpected response (HTTP ${res.status}).` };
}

function isJsonContentType(contentType: string | null): boolean {
  if (contentType === null) return false;
  const mime = (contentType.split(';')[0] ?? '').trim().toLowerCase();
  return mime === 'application/json' || mime === 'text/json' || mime.endsWith('+json');
}

/** Read at most MAX_PROBE_BODY_BYTES, on the SAME abort signal as the request. */
async function readBoundedBody(res: Response, signal: AbortSignal): Promise<string | undefined> {
  const body = res.body;
  if (body === null) return undefined;
  const reader = body.getReader();
  const onAbort = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    if (signal.aborted) return undefined;
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > MAX_PROBE_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        return undefined;
      }
      chunks.push(value);
    }
    const joined = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      joined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(joined);
  } catch {
    return undefined;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

/** OpenAI and Anthropic answer `{ data: [...] }`; some gateways `{ models: [...] }`. */
function looksLikeModelList(text: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  if (Array.isArray(parsed)) return true;
  if (typeof parsed !== 'object' || parsed === null) return false;
  const rec = parsed as Record<string, unknown>;
  return Array.isArray(rec['data']) || Array.isArray(rec['models']);
}
