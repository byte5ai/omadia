import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Minimal file + console logger. Writes to userData/logs/omadia-desktop.log so a
 * user can attach it to a bug report (tray → "Open Logs"). Avoids a heavy logging
 * dependency for v1.
 */

let stream: fs.WriteStream | null = null;

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
}

export const log = {
  info: (msg: string) => write('INFO', msg),
  warn: (msg: string) => write('WARN', msg),
  error: (msg: string) => write('ERROR', msg),
};
