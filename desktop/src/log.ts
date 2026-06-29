import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Minimal file + console logger. Writes to userData/logs/omadia-desktop.log so a
 * user can attach it to a bug report (tray → "Open Logs"). Avoids a heavy logging
 * dependency for v1.
 */

let stream: fs.WriteStream | null = null;

// Optional taps so the main process can mirror log lines to the wizard/loading
// UI during boot (install verbosity). Kept out of the file/console path so a
// throwing listener can never break logging.
export type LogLevel = 'INFO' | 'WARN' | 'ERROR';
type LogListener = (level: LogLevel, msg: string) => void;
const listeners = new Set<LogListener>();

/** Subscribe to every log line. Returns an unsubscribe. */
export function onLog(cb: LogListener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function logFilePath(): string {
  const dir = path.join(app.getPath('userData'), 'logs');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'omadia-desktop.log');
}

export function logFile(): string {
  return logFilePath();
}

function write(level: string, msg: string): void {
  const line = `${new Date().toISOString()} [${level}] ${msg}\n`;
  // eslint-disable-next-line no-console
  (level === 'ERROR' ? console.error : console.log)(line.trimEnd());
  try {
    if (!stream) {
      stream = fs.createWriteStream(logFilePath(), { flags: 'a' });
    }
    stream.write(line);
  } catch {
    /* never let logging crash the app */
  }
  for (const l of listeners) {
    try {
      l(level as LogLevel, msg);
    } catch {
      /* a bad tap must never break logging */
    }
  }
}

export const log = {
  info: (msg: string) => write('INFO', msg),
  warn: (msg: string) => write('WARN', msg),
  error: (msg: string) => write('ERROR', msg),
};
