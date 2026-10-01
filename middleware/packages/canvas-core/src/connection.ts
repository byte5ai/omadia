/** Connection lifecycle status reported by CanvasSocket.
 *  Moved out of the Electron IPC contract — platform-neutral.
 *
 *  Two states stop the reconnect loop because the server ended the socket's
 *  session and the same cookie can only be refused again:
 *  - `unauthenticated` — close 4401: the session expired. Renew it (an
 *    explicit user action) or sign in again, then call `connect()`.
 *  - `forbidden` — close 4403: the session was revoked (signed out elsewhere,
 *    password reset, account disabled or deleted) or the identity is no longer
 *    authorised. Only a fresh sign-in and `connect()` start over. */
export interface ConnectionStatus {
  state:
    | 'disconnected'
    | 'connecting'
    | 'ready'
    | 'failed'
    | 'unauthenticated'
    | 'forbidden';
  canvasSessionId?: string;
  detail?: string;
  /** On `ready`: when the session behind the socket expires, Unix epoch
   *  seconds (the server closes the socket with 4401 then). Use it to warn the
   *  user ahead of time; never renew silently. */
  sessionExpiresAt?: number;
  /** On `unauthenticated` / `forbidden`: the close code that ended the socket. */
  closeCode?: number;
}
