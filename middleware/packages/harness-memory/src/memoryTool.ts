import type { MemoryEntry, MemoryStore } from '@omadia/plugin-api';

import {
  MemoryAlreadyExistsError,
  MemoryInvalidPathError,
  MemoryIsDirectoryError,
  MemoryPathNotFoundError,
} from './filesystem.js';

/**
 * Client-side handler for the Anthropic `memory_20250818` tool. Implements the six
 * commands (view, create, str_replace, insert, delete, rename) against a MemoryStore.
 * Return strings follow the shapes described in the memory-tool docs so Claude keeps
 * interpreting them correctly.
 */
export class MemoryToolHandler {
  constructor(private readonly store: MemoryStore) {}

  async handle(input: unknown): Promise<string> {
    let cmd: MemoryCommand | undefined;
    try {
      cmd = parseCommand(input);
      const result = await this.dispatch(cmd);
      logMemoryCall(cmd, result, null);
      return result;
    } catch (err) {
      const formatted = formatError(err);
      logMemoryCall(cmd, formatted, err);
      return formatted;
    }
  }

  private async dispatch(cmd: MemoryCommand): Promise<string> {
    switch (cmd.command) {
      case 'view':
        return this.view(cmd.path, cmd.view_range);
      case 'create':
        return this.create(cmd.path, cmd.file_text);
      case 'str_replace':
        return this.strReplace(cmd.path, cmd.old_str, cmd.new_str);
      case 'insert':
        return this.insert(cmd.path, cmd.insert_line, cmd.insert_text);
      case 'delete':
        return this.delete(cmd.path);
      case 'rename':
        return this.rename(cmd.old_path, cmd.new_path);
    }
  }

  private async view(virtualPath: string, range?: [number, number]): Promise<string> {
    if (await this.store.directoryExists(virtualPath)) {
      const entries = await this.store.list(virtualPath);
      return formatDirectoryListing(virtualPath, entries);
    }
    if (!(await this.store.fileExists(virtualPath))) {
      return `The path ${virtualPath} does not exist. Please provide a valid path.`;
    }
    const content = await this.store.readFile(virtualPath);
    return formatFileContents(virtualPath, content, range);
  }

  private async create(virtualPath: string, fileText: string): Promise<string> {
    await this.store.createFile(virtualPath, fileText);
    return `File created at ${virtualPath}.`;
  }

  private async strReplace(virtualPath: string, oldStr: string, newStr: string): Promise<string> {
    if (!(await this.store.fileExists(virtualPath))) {
      return `Error: The path ${virtualPath} does not exist. Please provide a valid path.`;
    }
    const content = await this.store.readFile(virtualPath);
    const occurrences = countOccurrences(content, oldStr);
    if (occurrences === 0) {
      return `No replacement was performed, old_str \`${oldStr}\` did not appear verbatim in ${virtualPath}.`;
    }
    if (occurrences > 1) {
      const lines = findLineNumbers(content, oldStr);
      return `No replacement was performed. Multiple occurrences of old_str \`${oldStr}\` in lines: ${lines.join(', ')}. Please ensure it is unique`;
    }
    const replaced = content.replace(oldStr, newStr);
    await this.store.writeFile(virtualPath, replaced);
    return `The memory file has been edited.\n${formatFileContents(virtualPath, replaced)}`;
  }

  private async insert(
    virtualPath: string,
    insertLine: number,
    insertText: string,
  ): Promise<string> {
    if (!(await this.store.fileExists(virtualPath))) {
      return `Error: The path ${virtualPath} does not exist`;
    }
    const content = await this.store.readFile(virtualPath);
    const lines = content.split('\n');
    if (insertLine < 0 || insertLine > lines.length) {
      return `Error: Invalid \`insert_line\` parameter: ${insertLine}. It should be within the range of lines of the file: [0, ${lines.length}]`;
    }
    const payload = insertText.endsWith('\n') ? insertText.slice(0, -1) : insertText;
    const next = [...lines.slice(0, insertLine), payload, ...lines.slice(insertLine)].join('\n');
    await this.store.writeFile(virtualPath, next);
    return `The file ${virtualPath} has been edited.`;
  }

  private async delete(virtualPath: string): Promise<string> {
    await this.store.delete(virtualPath);
    return `Successfully deleted ${virtualPath}`;
  }

  private async rename(fromPath: string, toPath: string): Promise<string> {
    await this.store.rename(fromPath, toPath);
    return `Successfully renamed ${fromPath} to ${toPath}`;
  }
}

// ---------- parsing & formatting helpers ----------

type MemoryCommand =
  | { command: 'view'; path: string; view_range?: [number, number] }
  | { command: 'create'; path: string; file_text: string }
  | { command: 'str_replace'; path: string; old_str: string; new_str: string }
  | { command: 'insert'; path: string; insert_line: number; insert_text: string }
  | { command: 'delete'; path: string }
  | { command: 'rename'; old_path: string; new_path: string };

function parseCommand(input: unknown): MemoryCommand {
  if (typeof input !== 'object' || input === null) {
    throw new MemoryInvalidPathError('Tool input must be an object.');
  }
  const record = input as Record<string, unknown>;
  const command = record['command'];
  switch (command) {
    case 'view':
      return {
        command: 'view',
        path: requireString(record, 'path'),
        view_range: parseRange(record['view_range']),
      };
    case 'create':
      return {
        command: 'create',
        path: requireString(record, 'path'),
        file_text: requireString(record, 'file_text'),
      };
    case 'str_replace':
      return {
        command: 'str_replace',
        path: requireString(record, 'path'),
        old_str: requireString(record, 'old_str'),
        new_str: requireString(record, 'new_str'),
      };
    case 'insert':
      return {
        command: 'insert',
        path: requireString(record, 'path'),
        insert_line: requireInt(record, 'insert_line'),
        insert_text: requireString(record, 'insert_text'),
      };
    case 'delete':
      return { command: 'delete', path: requireString(record, 'path') };
    case 'rename':
      return {
        command: 'rename',
        old_path: requireString(record, 'old_path'),
        new_path: requireString(record, 'new_path'),
      };
    default:
      throw new MemoryInvalidPathError(`Unknown memory command: ${String(command)}`);
  }
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string') {
    throw new MemoryInvalidPathError(`Missing or non-string field: ${key}`);
  }
  return value;
}

function requireInt(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new MemoryInvalidPathError(`Missing or non-integer field: ${key}`);
  }
  return value;
}

function parseRange(value: unknown): [number, number] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length !== 2) {
    throw new MemoryInvalidPathError('view_range must be a two-element array.');
  }
  const [a, b] = value;
  if (typeof a !== 'number' || typeof b !== 'number') {
    throw new MemoryInvalidPathError('view_range entries must be numbers.');
  }
  return [a, b];
}

function formatDirectoryListing(virtualPath: string, entries: MemoryEntry[]): string {
  const header = `Here're the files and directories up to 2 levels deep in ${virtualPath}, excluding hidden items and node_modules:`;
  const lines = entries
    .map((entry) => `${humanSize(entry.sizeBytes)}\t${entry.virtualPath}`)
    .join('\n');
  return `${header}\n${lines}`;
}

function formatFileContents(
  virtualPath: string,
  content: string,
  range?: [number, number],
): string {
  const allLines = content.split('\n');
  const [startLine, endLine] = range ?? [1, allLines.length];
  const from = Math.max(1, startLine);
  const to = Math.min(allLines.length, endLine);
  const body: string[] = [];
  for (let i = from; i <= to; i++) {
    body.push(`${String(i).padStart(6, ' ')}\t${allLines[i - 1] ?? ''}`);
  }
  return `Here's the content of ${virtualPath} with line numbers:\n${body.join('\n')}`;
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  return `${(bytes / 1024 / 1024).toFixed(1)}M`;
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count++;
    idx += needle.length;
  }
  return count;
}

function findLineNumbers(haystack: string, needle: string): number[] {
  const lines = haystack.split('\n');
  const hits: number[] = [];
  lines.forEach((line, idx) => {
    if (line.includes(needle)) hits.push(idx + 1);
  });
  return hits;
}

function logMemoryCall(cmd: MemoryCommand | undefined, result: string, err: unknown): void {
  const cmdLabel = cmd
    ? `${cmd.command} ${'path' in cmd ? cmd.path : `${cmd.old_path} → ${cmd.new_path}`}`
    : 'UNPARSED_COMMAND';
  const outcome = err ? `ERROR (${err instanceof Error ? err.name : typeof err})` : 'ok';
  const snippet = result.replace(/\n/g, ' ⏎ ').slice(0, 240);
  console.log(`[memory] ${cmdLabel} → ${outcome}: ${snippet}`);
  if (err) {
    console.error('[memory] full error:', err);
  }
}

function formatError(err: unknown): string {
  if (err instanceof MemoryPathNotFoundError) {
    return `Error: ${err.message}`;
  }
  if (err instanceof MemoryAlreadyExistsError) {
    return `Error: File ${err.message.replace('Path already exists: ', '')} already exists`;
  }
  if (err instanceof MemoryIsDirectoryError) {
    return `Error: ${err.message}`;
  }
  if (err instanceof MemoryInvalidPathError) {
    return `Error: ${err.message}`;
  }
  return `Error: ${err instanceof Error ? err.message : String(err)}`;
}
