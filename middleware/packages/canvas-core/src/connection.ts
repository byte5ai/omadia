/** Connection lifecycle status reported by CanvasSocket.
 *  Moved out of the Electron IPC contract — platform-neutral. */
export interface ConnectionStatus {
  state: 'disconnected' | 'connecting' | 'ready' | 'failed';
  canvasSessionId?: string;
  detail?: string;
}
