import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { ChatSessionStore } from '@omadia/orchestrator';
import type { MemoryStore, MemoryEntry } from '@omadia/plugin-api';

/**
 * Unit test for `ChatSessionStore.resetMessages` — added 2026-05-26 to back
 * the new `POST /api/chat/sessions/:id/reset` endpoint that the web-ui's
 * composer-eraser button calls.
 */

class InMemoryStore implements MemoryStore {
  private files = new Map<string, string>();

  async list(virtualPath: string): Promise<MemoryEntry[]> {
    const prefix = virtualPath.endsWith('/') ? virtualPath : `${virtualPath}/`;
    const out: MemoryEntry[] = [];
    for (const [key, value] of this.files.entries()) {
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      if (rest.includes('/')) continue;
      out.push({
        virtualPath: key,
        isDirectory: false,
        sizeBytes: Buffer.byteLength(value),
      });
    }
    return out;
  }
  async fileExists(virtualPath: string): Promise<boolean> {
    return this.files.has(virtualPath);
  }
  async directoryExists(virtualPath: string): Promise<boolean> {
    const prefix = virtualPath.endsWith('/') ? virtualPath : `${virtualPath}/`;
    for (const key of this.files.keys()) {
      if (key.startsWith(prefix)) return true;
    }
    return false;
  }
  async readFile(virtualPath: string): Promise<string> {
    const v = this.files.get(virtualPath);
    if (v === undefined) throw new Error(`missing: ${virtualPath}`);
    return v;
  }
  async createFile(virtualPath: string, content: string): Promise<void> {
    if (this.files.has(virtualPath)) throw new Error(`exists: ${virtualPath}`);
    this.files.set(virtualPath, content);
  }
  async writeFile(virtualPath: string, content: string): Promise<void> {
    this.files.set(virtualPath, content);
  }
  async delete(virtualPath: string): Promise<void> {
    this.files.delete(virtualPath);
  }
  async rename(from: string, to: string): Promise<void> {
    const v = this.files.get(from);
    if (v === undefined) throw new Error(`missing: ${from}`);
    this.files.delete(from);
    this.files.set(to, v);
  }
}

const SESSION_ID = 'demo-session-1';
const sampleSession = {
  id: SESSION_ID,
  title: 'Demo Chat',
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_500_000,
  messages: [
    { id: 'm1', role: 'user' as const, content: 'hi', startedAt: 1_700_000_000_000 },
    {
      id: 'm2',
      role: 'assistant' as const,
      content: 'hello',
      startedAt: 1_700_000_001_000,
      finishedAt: 1_700_000_002_000,
    },
  ],
};

describe('ChatSessionStore.resetMessages', () => {
  it('clears messages but preserves id, title, createdAt', async () => {
    const mem = new InMemoryStore();
    const store = new ChatSessionStore(mem);
    await store.save(sampleSession);

    const result = await store.resetMessages(SESSION_ID);
    assert.ok(result, 'should return updated session');
    assert.equal(result.id, SESSION_ID);
    assert.equal(result.title, 'Demo Chat');
    assert.equal(result.createdAt, 1_700_000_000_000);
    assert.equal(result.messages.length, 0);
    assert.ok(
      result.updatedAt > sampleSession.updatedAt,
      'updatedAt must advance',
    );

    // Persisted state matches.
    const reread = await store.get(SESSION_ID);
    assert.ok(reread);
    assert.equal(reread.messages.length, 0);
    assert.equal(reread.title, 'Demo Chat');
  });

  it('returns null for unknown session', async () => {
    const mem = new InMemoryStore();
    const store = new ChatSessionStore(mem);
    const result = await store.resetMessages('nope-not-there');
    assert.equal(result, null);
  });

  it('rejects malformed ids', async () => {
    const mem = new InMemoryStore();
    const store = new ChatSessionStore(mem);
    await assert.rejects(() => store.resetMessages('../etc/passwd'));
  });
});
