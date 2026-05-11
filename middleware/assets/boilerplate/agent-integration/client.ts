/**
 * {{AGENT_NAME}} — External API Client
 *
 * Reine Business-Logik gegen die externe API. Kein LLM-/Zod-Code hier
 * (das lebt im toolkit). Macht den Client ohne Orchestrator-Stub testbar.
 */

export interface ClientOptions {
  baseUrl: string;
  token: string;
  timeoutMs: number;
  log: (...args: unknown[]) => void;
}

export interface Client {
  ping(): Promise<void>;
  search(query: string): Promise<SearchResult[]>;
  dispose(): Promise<void>;
}

export interface SearchResult {
  id: string;
  title: string;
  url: string;
}

export function createClient(opts: ClientOptions): Client {
  // #region builder:client-impl
  const baseHeaders = {
    Authorization: `Bearer ${opts.token}`,
    Accept: 'application/json',
  };

  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const url = `${opts.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
    try {
      const res = await fetch(url, {
        ...init,
        headers: { ...baseHeaders, ...init.headers },
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(
          `{{AGENT_SLUG}}: ${res.status} ${res.statusText} — ${body.slice(0, 200)}`,
        );
      }
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async ping() {
      await request<unknown>('/ping');
    },

    async search(query) {
      const params = new URLSearchParams({ q: query });
      return request<SearchResult[]>(`/search?${params.toString()}`);
    },

    async dispose() {
      // Keep-alive sockets schließen, Metriken flushen, etc.
    },
  };
  // #endregion
}
