import { z } from 'zod';
import {
  ALLOWED_DIAGRAM_KINDS,
  DiagramRenderError,
  DiagramRenderTooLargeError,
  DiagramSourceTooLargeError,
  UnsupportedDiagramKindError,
  type RenderInput,
  type RenderOutput,
} from './types.js';
import type { DiagramService } from './diagramService.js';

/**
 * Subset of the kernel MemoryStore interface the DiagramTool relies on for
 * the brand-logo auto-lookup. Declared locally so the package stays free of
 * `../memory/store.js` imports — structurally compatible with the kernel's
 * FilesystemMemoryStore that gets injected via `ctx.services.get('memoryStore')`.
 */
export interface DiagramBrandMemory {
  fileExists(path: string): Promise<boolean>;
  readFile(path: string): Promise<string>;
}

const BRAND_LOGO_PLACEHOLDER = 'brand://logo';
const BRAND_LOGO_MEMORY_PATH = '/memories/_brand/logo.md';

const DiagramInputSchema = z.object({
  kind: z.enum(ALLOWED_DIAGRAM_KINDS),
  source: z.string().min(1, 'source must be non-empty'),
  title: z.string().max(200).optional(),
  // Snake-case in the tool schema, camelCase in the RenderInput.
  brand_logo_storage_key: z.string().min(1).max(400).optional(),
});

export const DIAGRAM_TOOL_NAME = 'render_diagram';

/**
 * Tool spec exposed to Claude. Mirrors the shape of `knowledgeGraphToolSpec`
 * (handwritten JSON schema rather than auto-derived from Zod) so the Anthropic
 * SDK sees exactly the keys the Messages API expects.
 */
export const diagramToolSpec = {
  name: DIAGRAM_TOOL_NAME,
  description:
    'Rendere ein Diagramm und gib eine signierte PNG-URL zurück, die inline in der Antwort angezeigt wird. Nutze dieses Tool bei Visualisierungs-Wünschen (Flow, Ablauf, Org-Chart, Sequenz, Klasse, State, Abhängigkeiten) oder wenn Fachagent-Daten als Bild klarer werden (z.B. Umsatz-Chart, Top-Kunden-Balken).\n\nWähle `kind`:\n- `mermaid`: Flow/Sequenz/State/Gantt/Class/ER.\n- `graphviz`: dichte gerichtete Graphen, Abhängigkeits-Bäume.\n- `plantuml`: klassische UML (Sequence, Component, Deployment).\n- `vegalite`: **quantitative Charts** — Bar/Line/Pie/Scatter/Area aus tabellarischen Daten. Nutze das, wenn du Zahlen aus einem Fachagenten visualisierst (Umsatz-pro-Monat, Top-Kunden-Balken, Verteilungen, Zeitreihen). Die `source` ist ein kompletter Vega-Lite-JSON-Spec als String (beginnend mit `{"$schema":"https://vega.github.io/schema/vega-lite/v5.json",...}`). Encode deine Daten inline in `data.values`.\n\nDie `source` ist der rohe Diagramm-Text im jeweiligen Format (kein Code-Fence, kein Markdown-Wrapper). Halte Quellen unter 1 MB. Die Antwort enthält eine signierte URL — der Teams-Adapter rendert das Bild automatisch als Adaptive-Card-Image; zitiere die URL nicht wörtlich im Antworttext, formuliere stattdessen einen kurzen Satz wie "Hier das Diagramm:".\n\n**Brand-Asset-Einbettung (Logo):** Wenn der User "mit Branding", "mit unserem Logo" oder "mit Corporate Design" anfragt UND `/memories/_brand/logo.md` existiert, schreibe in die `source` den Platzhalter-URL `brand://logo` (z.B. Vega-Lite: `{"mark":"image","encoding":{"url":{"value":"brand://logo"}, ...}}`; Graphviz: `node [image="brand://logo"]`) UND übergib den `storage_key` aus der Memory-Datei als Parameter `brand_logo_storage_key`. Die Middleware fetcht das Logo intern aus Tigris und base64-inlined es in den Spec BEVOR Kroki ihn bekommt — so umgeht der Renderer sein Public-Egress-Limit. Ohne den Parameter bleibt `brand://logo` ungeändert und Kroki rendert die Bild-Stelle als Fehlbild.',
  input_schema: {
    type: 'object' as const,
    properties: {
      kind: {
        type: 'string',
        enum: [...ALLOWED_DIAGRAM_KINDS],
        description: 'Diagramm-Format.',
      },
      source: {
        type: 'string',
        description:
          'Roher Diagramm-Quelltext im gewählten Format. Für Mermaid keine ```mermaid-Fences. Für `vegalite` ein vollständiges Vega-Lite-JSON als String mit `$schema` und `data.values`.',
      },
      title: {
        type: 'string',
        description: 'Optionaler Titel für die Bild-Alt-Texts (für Screenreader).',
      },
      brand_logo_storage_key: {
        type: 'string',
        description:
          'Optional. Tigris-Storage-Key des byte5-Logos (aus `/memories/_brand/logo.md`). Setz dies, wenn deine `source` den Platzhalter `brand://logo` enthält — die Middleware lädt das Logo und base64-inlined es. Nur Keys mit Präfix `teams-attachments/` werden akzeptiert.',
      },
    },
    required: ['kind', 'source'],
  },
};

/**
 * Orchestrator-side wrapper around the DiagramService. Follows the exact
 * shape of `KnowledgeGraphTool` (class with a string-returning `handle`) so
 * the Orchestrator can dispatch it alongside the memory + graph tools without
 * a special-case code path.
 *
 * Returns a compact JSON object: `{ url, kind, cacheHit, title? }`. The LLM
 * only needs the URL to mention the diagram by reference; the full RenderOutput
 * surfaces via the `lastRenderedDiagram()` accessor so the orchestrator can
 * attach an Image element to the outgoing Teams card without re-parsing the
 * tool-result string.
 */
export class DiagramTool {
  private lastRender: RenderOutput | undefined;

  constructor(
    private readonly service: DiagramService,
    /**
     * Optional. When set, the tool auto-reads `/memories/_brand/logo.md`
     * whenever the Vega-Lite/Graphviz/PlantUML spec references
     * `brand://logo` but Claude forgot to pass `brand_logo_storage_key`.
     * This makes logo embedding robust against prompt-compliance slips.
     */
    private readonly memoryStore?: DiagramBrandMemory,
    private readonly log: (msg: string) => void = (msg) => {
      console.error(msg);
    },
  ) {}

  async handle(input: unknown): Promise<string> {
    const parsed = DiagramInputSchema.safeParse(input);
    if (!parsed.success) {
      return `Error: invalid diagram input — ${parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`;
    }

    try {
      const { brand_logo_storage_key, ...rest } = parsed.data;
      const renderInput: RenderInput = {
        ...rest,
        ...(brand_logo_storage_key
          ? { brandLogoStorageKey: brand_logo_storage_key }
          : {}),
      };

      // Auto-lookup: if the spec uses the `brand://logo` placeholder but
      // Claude didn't pass the storage key, fetch it from the brand
      // memory-file ourselves. Keeps the logo flow working even when the
      // orchestrator's §13 compliance slips (happens especially right
      // after a prompt update while the cache is still warm).
      if (
        !renderInput.brandLogoStorageKey &&
        renderInput.source.includes(BRAND_LOGO_PLACEHOLDER) &&
        this.memoryStore
      ) {
        const key = await this.lookupBrandLogoKey();
        if (key) {
          renderInput.brandLogoStorageKey = key;
          this.log(
            `[diagram-tool] auto-injected brand_logo_storage_key from memory key=…${key.slice(-32)}`,
          );
        }
      }

      const output = await this.service.render(renderInput);
      this.lastRender = output;
      return JSON.stringify({
        kind: output.kind,
        url: output.url,
        cacheHit: output.cacheHit,
        ...(output.title ? { title: output.title } : {}),
      });
    } catch (err) {
      if (
        err instanceof UnsupportedDiagramKindError ||
        err instanceof DiagramSourceTooLargeError ||
        err instanceof DiagramRenderTooLargeError
      ) {
        return `Error: ${err.message}`;
      }
      if (err instanceof DiagramRenderError) {
        return `Error: upstream renderer failed — ${err.message}`;
      }
      const message = err instanceof Error ? err.message : String(err);
      return `Error: ${message}`;
    }
  }

  /**
   * Returns the most recent successful render done by this tool instance and
   * clears it. Called once per orchestrator turn so the next turn starts
   * clean even if the tool wasn't invoked. Safe to call when no render
   * happened — returns undefined.
   */
  takeLastRender(): RenderOutput | undefined {
    const render = this.lastRender;
    this.lastRender = undefined;
    return render;
  }

  /**
   * Read `/memories/_brand/logo.md` and extract the `storage_key` field
   * from its YAML-ish frontmatter (simple `key: value` lines). Returns
   * undefined when the file is missing, unparseable, or the key has a
   * disallowed prefix (security: keep arbitrary-blob-fetch via the
   * `brand://logo` placeholder impossible).
   */
  private async lookupBrandLogoKey(): Promise<string | undefined> {
    if (!this.memoryStore) return undefined;
    try {
      const exists = await this.memoryStore.fileExists(BRAND_LOGO_MEMORY_PATH);
      if (!exists) return undefined;
      const content = await this.memoryStore.readFile(BRAND_LOGO_MEMORY_PATH);
      // YAML frontmatter or bare `key: value` lines — both fine for our
      // simple schema. Tolerant of an optional leading "---" block.
      const match = /(^|\n)\s*storage_key\s*:\s*([^\n\r]+)/.exec(content);
      if (!match || !match[2]) return undefined;
      const rawKey = match[2].trim().replace(/^["']|["']$/g, '');
      if (!rawKey.startsWith('teams-attachments/')) {
        this.log(
          `[diagram-tool] brand-logo key in memory has disallowed prefix — ignoring key=${rawKey.slice(0, 40)}`,
        );
        return undefined;
      }
      return rawKey;
    } catch (err) {
      this.log(
        `[diagram-tool] brand-logo lookup FAIL: ${err instanceof Error ? err.message : String(err)}`,
      );
      return undefined;
    }
  }
}
