import { contextBridge, ipcRenderer } from 'electron';
import {
  CH,
  type TestLlmKeyRequest,
  type TestLlmKeyResult,
  type WizardConfig,
  type CompleteResult,
  type BootLogLine,
} from './ipcTypes';
import type { BootProgress } from './supervisor';
import { bridgeSurfaceFor } from './bridgeSurface';

/**
 * The renderer bridge, cut down to what the loaded document is entitled to.
 * contextIsolation is on and nodeIntegration off; a page only ever sees the
 * narrow, typed surface picked here (see `bridgeSurface.ts`):
 *
 *  - the bundled wizard gets the setup methods and the boot stream;
 *  - the bundled loading screen gets the boot stream only;
 *  - the loopback web UI gets `uiReady` and `setUiLocale` — nothing that
 *    returns or writes a secret, because third-party plugin UIs run in
 *    same-origin iframes there and reach this bridge via `window.parent`;
 *  - any other document gets no bridge at all.
 *
 * Main refuses every call from a document that is not entitled to its channel
 * (`ipcSender.ts`); this split keeps the methods out of reach in the first place.
 */
const bootApi = {
  onBootProgress: (cb: (p: BootProgress) => void): (() => void) => {
    const listener = (_e: unknown, p: BootProgress): void => cb(p);
    ipcRenderer.on(CH.bootProgress, listener);
    return () => ipcRenderer.removeListener(CH.bootProgress, listener);
  },
  onBootLog: (cb: (line: BootLogLine) => void): (() => void) => {
    const listener = (_e: unknown, line: BootLogLine): void => cb(line);
    ipcRenderer.on(CH.bootLog, listener);
    return () => ipcRenderer.removeListener(CH.bootLog, listener);
  },
};

const wizardApi = {
  testLlmKey: (req: TestLlmKeyRequest): Promise<TestLlmKeyResult> =>
    ipcRenderer.invoke(CH.testLlmKey, req),
  chooseDataDir: (): Promise<string | null> => ipcRenderer.invoke(CH.chooseDataDir),
  /** The key for the folder setup will complete with (`WizardConfig.dataDir`). */
  exportRecoveryKey: (dataDir: string | null): Promise<string> =>
    ipcRenderer.invoke(CH.exportRecoveryKey, dataDir),
  complete: (config: WizardConfig): Promise<CompleteResult> =>
    ipcRenderer.invoke(CH.complete, config),
  ...bootApi,
};

const appApi = {
  /**
   * OM-71 — the web UI calls this once its first real screen is up, so shell
   * dialogs (the recovery-key reminder) wait for a page rather than a
   * navigation. Fire-and-forget; the web UI must keep working in a browser
   * where this bridge does not exist.
   */
  uiReady: (): void => ipcRenderer.send(CH.uiReady),
  /**
   * #1074 — the web UI reports the language it is showing, on load and after
   * every switch, so the shell's own dialogs and menu speak it too. Main
   * accepts only `'en'` and `'de'`. Fire-and-forget; the web UI must keep
   * working in a browser where this bridge does not exist.
   */
  setUiLocale: (locale: string): void => ipcRenderer.send(CH.uiLocale, locale),
};

switch (bridgeSurfaceFor(window.location.href)) {
  case 'wizard':
    contextBridge.exposeInMainWorld('omadia', wizardApi);
    break;
  case 'boot':
    contextBridge.exposeInMainWorld('omadia', bootApi);
    break;
  case 'app':
    contextBridge.exposeInMainWorld('omadia', appApi);
    break;
  case 'none':
    // A foreign document (an IdP page reached by a redirect, about:blank, …)
    // gets no `window.omadia`. The web UI, wizard.js and loading.js all
    // tolerate a missing bridge.
    break;
}

export type OmadiaBridge = typeof wizardApi;
