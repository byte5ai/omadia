import {
  ipcMain,
  dialog,
  BrowserWindow,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type WebContents,
} from 'electron';
import os from 'node:os';
import {
  CH,
  type ApiKeyProvider,
  type TestLlmKeyRequest,
  type TestLlmKeyResult,
  type WizardConfig,
  type CompleteResult,
} from './ipcTypes';
import type { BootProgress } from './supervisor';
import type { ShellView } from './shellView';
import { decideSender, readSenderFacts, type IpcSurface } from './ipcSender';
import { setProviderKey, exportRecoveryKey } from './secrets';
import { readSetup, writeSetup } from './setupState';
import { setDataDirOverride } from './paths';
import { detectSyncedLocation } from './syncedPaths';
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
  /** OM-71: the web UI reports that its first real screen is standing. */
  onUiReady: () => void;
  /**
   * #1074: the web UI reports the language it is showing. Deliberately
   * `unknown`: the value comes from a renderer, and the only way in is
   * through `parseUiLocale`.
   */
  onUiLocale: (locale: unknown) => void;
  /**
   * What the window navigator says is on screen. The setup channels answer
   * only while it is the wizard, so the recovery key is out of reach once
   * first-run setup is over.
   */
  currentView: () => ShellView;
  /** The running web UI's origin, or null while none serves; the UI pings answer only it. */
  appOrigin: () => string | null;
  /** Absolute path of the bundled pages (`<app>/dist/renderer`); setup answers only its wizard.html. */
  rendererDir: string;
}

/** What a refused invoke rejects with; the wizard shows invoke errors verbatim. */
const REFUSED = 'This action is not available from here.';

/**
 * `ipcMain.handle` / `ipcMain.on` with the sender check in front. The handler
 * declares its renderer arguments; they arrive unchecked, exactly as with bare
 * `ipcMain`, so each handler still validates what it uses.
 */
interface SenderGuards {
  guardedHandle<A extends unknown[]>(
    surface: IpcSurface,
    channel: string,
    handler: (event: IpcMainInvokeEvent, ...args: A) => unknown,
  ): void;
  guardedOn<A extends unknown[]>(
    surface: IpcSurface,
    channel: string,
    listener: (event: IpcMainEvent, ...args: A) => void,
  ): void;
}

/**
 * Builds the guarded registrations, with `decideSender` (`ipcSender.ts`) in
 * front of every handler.
 *
 * The sender frame is read on entry, synchronously, before the handler runs:
 * Electron answers null for `senderFrame` once the frame has navigated away, so
 * a check behind an `await` would refuse the wizard in the middle of `complete`.
 */
function senderGuards(deps: IpcDeps): SenderGuards {
  const refused = (
    surface: IpcSurface,
    channel: string,
    event: IpcMainEvent | IpcMainInvokeEvent,
  ): boolean => {
    const decision = decideSender(surface, readSenderFacts(event), {
      rendererDir: deps.rendererDir,
      appOrigin: deps.appOrigin(),
      view: deps.currentView(),
    });
    if (decision.allowed) return false;
    const line = `[ipc] ${channel} refused: ${decision.reason}`;
    // A refused setup channel is either a document probing for the key or a
    // path mismatch that would brick first-run setup: loud either way. A UI
    // ping refused after a stop or restart is routine.
    if (surface === 'wizard') log.warn(line);
    else log.info(line);
    return true;
  };
  return {
    guardedHandle: <A extends unknown[]>(
      surface: IpcSurface,
      channel: string,
      handler: (event: IpcMainInvokeEvent, ...args: A) => unknown,
    ): void => {
      ipcMain.handle(channel, (event, ...args) => {
        if (refused(surface, channel, event)) throw new Error(REFUSED);
        return handler(event, ...(args as A));
      });
    },
    guardedOn: <A extends unknown[]>(
      surface: IpcSurface,
      channel: string,
      listener: (event: IpcMainEvent, ...args: A) => void,
    ): void => {
      ipcMain.on(channel, (event, ...args) => {
        if (!refused(surface, channel, event)) listener(event, ...(args as A));
      });
    },
  };
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

/** Tries before we stop re-opening the picker, so a warning can never trap the user. */
const MAX_DATA_DIR_PICKS = 3;

/**
 * Ask for a data directory, and if the answer is inside a cloud-synced folder,
 * say so before accepting it.
 *
 * A business user picks the folder he uses for important data, which is exactly
 * the folder that gets synced. A live PostgreSQL cluster there is a known
 * hazard: the sync client can evict, lock or fork files into conflict copies
 * while the database holds them open. This is a hint and not a ban - the user
 * may have a good reason, and the choice stays his (#934).
 */
async function chooseDataDirWithSyncWarning(
  win: BrowserWindow | undefined,
): Promise<string | null> {
  for (let attempt = 0; attempt < MAX_DATA_DIR_PICKS; attempt += 1) {
    const res = await dialog.showOpenDialog(win as BrowserWindow, {
      title: 'Choose where omadia stores its data',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (res.canceled || res.filePaths.length === 0) return null;

    const chosen = res.filePaths[0];
    if (chosen === undefined) return null;

    const synced = detectSyncedLocation(chosen, os.homedir());
    if (synced === null) return chosen;

    log.warn(`[setup] chosen data dir is inside ${synced}: ${chosen}`);
    const { response } = await dialog.showMessageBox(win as BrowserWindow, {
      type: 'warning',
      buttons: ['Choose a different folder', 'Use this folder anyway'],
      defaultId: 0,
      cancelId: 0,
      title: 'This folder is synced to the cloud',
      message: `${chosen} looks like it is inside ${synced}.`,
      detail:
        `omadia runs a live PostgreSQL database in this folder. ${synced} can lock, ` +
        'move or duplicate files while the database has them open, which can corrupt it. ' +
        'A local folder outside the synced area is the safer choice.\n\n' +
        'Pre-update database backups will be kept outside the synced folder either way.',
    });
    if (response === 1) return chosen;
  }
  log.warn('[setup] data dir selection abandoned after repeated cloud-folder warnings');
  return null;
}

/**
 * Every channel is registered for the one surface allowed to use it, and each
 * call is checked against the frame that sent it (`ipcSender.ts`): setup
 * channels answer only the bundled wizard during first-run setup, the UI pings
 * only the running web UI's origin. A new channel goes through
 * `guardedHandle`/`guardedOn` with an explicit surface, never bare `ipcMain`.
 */
export function registerIpc(deps: IpcDeps): void {
  const { guardedHandle, guardedOn } = senderGuards(deps);

  guardedOn('app', CH.uiReady, () => deps.onUiReady());
  // The payload is validated down to 'en' | 'de' and only picks the language
  // of shell dialogs.
  guardedOn('app', CH.uiLocale, (_e, locale: unknown) => deps.onUiLocale(locale));

  guardedHandle('wizard', CH.testLlmKey, async (_e, req: TestLlmKeyRequest): Promise<TestLlmKeyResult> => {
    return testLlmKey(req);
  });

  guardedHandle('wizard', CH.chooseDataDir, async (e): Promise<string | null> => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? undefined;
    return chooseDataDirWithSyncWarning(win as BrowserWindow);
  });

  // KNOWN GAP (OM-58), and the one-line fix belongs right here: the wizard's
  // "Reveal" button reaches the key through this handler, but nothing records
  // that the user has SEEN it. Only the shell's own Help → "Show recovery key…"
  // path sets `recoveryKeyShown` (see `recoveryKeyActions.ts`), so a user who
  // read the key off the wizard's last step still gets one reminder on the next
  // launch. Calling `markRecoveryKeyShown()` here closes that — it was left out
  // only because this file belonged to a concurrent PR at the time.
  guardedHandle('wizard', CH.exportRecoveryKey, (): string => exportRecoveryKey());

  guardedHandle('wizard', CH.complete, async (e, config: WizardConfig): Promise<CompleteResult> => {
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
