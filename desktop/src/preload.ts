import { contextBridge, ipcRenderer } from 'electron';
import {
  CH,
  AppState,
  TestLlmKeyRequest,
  TestLlmKeyResult,
  WizardConfig,
  CompleteResult,
  BootLogLine,
} from './ipcTypes';
import type { BootProgress } from './supervisor';

/**
 * Secure bridge for the onboarding wizard renderer. contextIsolation is on and
 * nodeIntegration off; the renderer only ever sees this narrow, typed surface.
 */
const api = {
  getState: (): Promise<AppState> => ipcRenderer.invoke(CH.getState),
  testLlmKey: (req: TestLlmKeyRequest): Promise<TestLlmKeyResult> =>
    ipcRenderer.invoke(CH.testLlmKey, req),
  chooseDataDir: (): Promise<string | null> => ipcRenderer.invoke(CH.chooseDataDir),
  exportRecoveryKey: (): Promise<string> => ipcRenderer.invoke(CH.exportRecoveryKey),
  complete: (config: WizardConfig): Promise<CompleteResult> =>
    ipcRenderer.invoke(CH.complete, config),
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

contextBridge.exposeInMainWorld('omadia', api);

export type OmadiaBridge = typeof api;
