import type {
  NativeToolAttachment,
  PluginContext,
} from '@omadia/plugin-api';

import { DiagramService } from './diagramService.js';
import { DiagramTool, diagramToolSpec, type DiagramBrandMemory } from './diagramTool.js';
import { createDiagramsRouter } from './diagramsRouter.js';
import { createKrokiClient } from './krokiClient.js';
import { createTigrisStore } from './tigrisStore.js';

/**
 * @omadia/diagrams — plugin entry point for kind: tool packages.
 *
 * Wires the DiagramService (Kroki client + Tigris signed-URL store), exposes
 * `render_diagram` as a native tool and mounts `/diagrams/<signed-key>` as
 * an Express route. Brand-logo auto-lookup is opt-in: if the kernel has
 * registered a `memoryStore` service, the tool reads `/memories/_brand/logo.md`
 * to auto-inject the storage key when Claude's spec references `brand://logo`
 * but forgets the explicit parameter.
 *
 * Required config (via ctx.config):
 *   - kroki_base_url           e.g. `https://kroki.io`
 *   - public_base_url          absolute origin the middleware is served on
 *                              (used when building the signed proxy URL)
 *   - tigris_bucket            name of the object-storage bucket
 *   - tigris_endpoint          e.g. `https://fly.storage.tigris.dev`
 *
 * Required secrets (via ctx.secrets):
 *   - diagram_url_secret       HMAC key for signed URLs (>= 32 bytes)
 *   - aws_access_key_id        Tigris access key
 *   - aws_secret_access_key    Tigris secret key
 *
 * Optional config:
 *   - tenant_id                prefix for keys; default `dev`
 *   - signed_url_ttl_sec       default 3600
 *   - max_source_bytes         default 1_048_576
 *   - max_png_bytes            default 10_485_760
 */

const SYSTEM_PROMPT_DOC = `\`render_diagram\`: Erzeugt ein Diagramm und gibt eine signierte PNG-URL zurück. Wähle das Format passend zum Inhalt: **Mermaid** für Flow/Sequenz/State/Gantt, **Graphviz** für dichte gerichtete Graphen, **PlantUML** für klassische UML, **Vega-Lite** für quantitative Charts (Bar/Line/Pie/Scatter/Area aus Zahlen eines Fach-Agenten). Nutze es, wenn der Nutzer Visualisierung anfragt (Flow, Org-Chart, Chart, "zeig mir als Balken/Kurve") **oder** wenn Fach-Agent-Ergebnisse als Bild deutlich klarer werden (Umsatz-Chart, Top-Kunden-Balken, Team-Struktur, Rechnungs-Workflow). Die Antwort enthält eine signierte URL — Teams + Web-UI rendern das Bild automatisch. **Zitiere die URL nicht** im Antworttext; formuliere stattdessen einen kurzen deutschen Satz wie "Hier das Diagramm:" und lass die Card das Bild anhängen.`;

export interface DiagramsPluginHandle {
  close(): Promise<void>;
}

export async function activate(ctx: PluginContext): Promise<DiagramsPluginHandle> {
  ctx.log('activating diagrams plugin');

  const krokiBaseUrl = ctx.config.require<string>('kroki_base_url');
  const publicBaseUrl = ctx.config.require<string>('public_base_url');
  const tigrisBucket = ctx.config.require<string>('tigris_bucket');
  const tigrisEndpoint = ctx.config.require<string>('tigris_endpoint');
  const tenantId = ctx.config.get<string>('tenant_id') ?? 'dev';
  const signedUrlTtlSec = ctx.config.get<number>('signed_url_ttl_sec') ?? 3600;
  const maxSourceBytes = ctx.config.get<number>('max_source_bytes') ?? 1_048_576;
  const maxPngBytes = ctx.config.get<number>('max_png_bytes') ?? 10_485_760;

  const signingSecret = await ctx.secrets.require('diagram_url_secret');
  const awsAccessKeyId = await ctx.secrets.require('aws_access_key_id');
  const awsSecretAccessKey = await ctx.secrets.require('aws_secret_access_key');

  const store = createTigrisStore({
    endpoint: tigrisEndpoint,
    accessKeyId: awsAccessKeyId,
    secretAccessKey: awsSecretAccessKey,
    bucket: tigrisBucket,
  });
  const kroki = createKrokiClient({ baseUrl: krokiBaseUrl });
  const service = new DiagramService({
    kroki,
    store,
    tenantId,
    secret: signingSecret,
    publicBaseUrl,
    signedUrlTtlSec,
    maxSourceBytes,
    maxPngBytes,
    log: (msg) => ctx.log(msg),
  });

  // Brand-logo auto-lookup reads /memories/_brand/logo.md which is outside
  // the plugin's own scope. Accessed via the `memoryStore` kernel service —
  // present if the host registered it at boot, absent otherwise. When absent
  // the auto-lookup is skipped; the LLM must pass brand_logo_storage_key
  // explicitly (still works, just no forgot-the-param safety net).
  const memoryStore = ctx.services.get<DiagramBrandMemory>('memoryStore');
  const tool = new DiagramTool(service, memoryStore, (msg) => ctx.log(msg));

  const disposeTool = ctx.tools.register(
    diagramToolSpec,
    (input) => tool.handle(input),
    {
      promptDoc: SYSTEM_PROMPT_DOC,
      attachmentSink: (): NativeToolAttachment[] | undefined => {
        const render = tool.takeLastRender();
        if (!render) return undefined;
        return [
          {
            kind: 'diagram',
            payload: {
              url: render.url,
              altText: render.title ?? `${render.kind} diagram`,
              diagramKind: render.kind,
              cacheHit: render.cacheHit,
            },
          },
        ];
      },
    },
  );

  const router = createDiagramsRouter({ store, secret: signingSecret });
  const disposeRoute = ctx.routes.register('/diagrams', router);

  ctx.log(
    `[diagrams] ready (kroki=${krokiBaseUrl}, bucket=${tigrisBucket}, tenant=${tenantId})`,
  );

  return {
    async close(): Promise<void> {
      ctx.log('deactivating diagrams plugin');
      disposeTool();
      disposeRoute();
    },
  };
}
