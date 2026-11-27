import {
  GENERATED_OBJECTS_SERVICE_NAME,
  type GeneratedObjectsService,
  type NativeToolAttachment,
  type PluginContext,
} from '@omadia/plugin-api';

import { DiagramService } from './diagramService.js';
import { DiagramTool, diagramToolSpec, type DiagramBrandMemory } from './diagramTool.js';
import { createDiagramsRouter } from './diagramsRouter.js';
import { createKrokiClient } from './krokiClient.js';
import { configFlag, isInternalKrokiEndpoint } from './krokiEndpoint.js';
import { createTigrisStore } from './tigrisStore.js';

/** The producer id the kernel files this plugin's renders under (ADR-0187). */
const PRODUCER_ID = '@omadia/diagrams';

/**
 * @omadia/diagrams — plugin entry point for kind: tool packages.
 *
 * Wires the DiagramService (Kroki client + Tigris signed-URL store), exposes
 * `render_diagram` as a native tool and mounts `/diagrams/dl/<signed-key>` as
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
 *   - tenant_id                prefix for keys; default `default`
 *   - signed_url_ttl_sec       default 3600
 *   - max_source_bytes         default 1_000_000
 *   - max_png_bytes            default 900_000 (Teams refuses card images > 1 MB)
 *
 * #1975 — these defaults match the env auto-install (`config.ts`), so a Store
 * install and an env install behave the same.
 */

const SYSTEM_PROMPT_DOC = `\`render_diagram\`: Erzeugt ein Diagramm und gibt eine signierte PNG-URL zurück. Wähle das Format passend zum Inhalt: **Mermaid** für Flow/Sequenz/State/Gantt, **Graphviz** für dichte gerichtete Graphen, **PlantUML** für klassische UML, **Vega-Lite** für quantitative Charts (Bar/Line/Pie/Scatter/Area aus Zahlen eines Fach-Werkzeugs). Nutze es, wenn der Nutzer Visualisierung anfragt (Flow, Org-Chart, Chart, "zeig mir als Balken/Kurve") **oder** wenn Ergebnisse von Fach-Werkzeugen als Bild deutlich klarer werden (Umsatz-Chart, Top-Kunden-Balken, Team-Struktur, Rechnungs-Workflow). Die Antwort enthält eine signierte URL — Teams + Web-UI rendern das Bild automatisch. **Zitiere die URL nicht** im Antworttext; formuliere stattdessen einen kurzen deutschen Satz wie "Hier das Diagramm:" und lass die Card das Bild anhängen.`;

/** The one member of the kernel's `turnContext` service this plugin reads. */
interface TurnIdSource {
  currentTurnId(): string | undefined;
}

export interface DiagramsPluginHandle {
  close(): Promise<void>;
}

export async function activate(ctx: PluginContext): Promise<DiagramsPluginHandle> {
  ctx.log('activating diagrams plugin');

  const krokiBaseUrl = ctx.config.require<string>('kroki_base_url');
  // #2338 / ADR-0299 — a renderer inside the instance is no integration
  // egress: the tool declares `none`. Any other endpoint keeps the
  // write-like check (a turn with another conversation's label is refused).
  const krokiInternal = isInternalKrokiEndpoint(krokiBaseUrl, configFlag(ctx.config.get<unknown>('kroki_internal')));
  const publicBaseUrl = ctx.config.require<string>('public_base_url');
  const tigrisBucket = ctx.config.require<string>('tigris_bucket');
  const tigrisEndpoint = ctx.config.require<string>('tigris_endpoint');
  const tenantId = ctx.config.get<string>('tenant_id') ?? 'default';
  const signedUrlTtlSec = ctx.config.get<number>('signed_url_ttl_sec') ?? 3600;
  const maxSourceBytes = ctx.config.get<number>('max_source_bytes') ?? 1_000_000;
  const maxPngBytes = ctx.config.get<number>('max_png_bytes') ?? 900_000;

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
  // ADR-0187 (#1986) — renders are recorded under the turn's person and chat
  // and deleted with them. Optional: without the kernel service the bucket's
  // lifecycle rule is the only expiry.
  const generated = ctx.services.get<GeneratedObjectsService>(GENERATED_OBJECTS_SERVICE_NAME);
  const deleteObject = store.delete?.bind(store);
  const disposeDeleter = deleteObject ? generated?.registerDeleter(PRODUCER_ID, deleteObject) : undefined;
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
    ...(generated ? { onPersisted: (key: string) => generated.record(PRODUCER_ID, key) } : {}),
  });

  // Brand-logo auto-lookup reads /memories/_brand/logo.md which is outside
  // the plugin's own scope. Accessed via the `memoryStore` kernel service —
  // present if the host registered it at boot, absent otherwise. When absent
  // the auto-lookup is skipped; the LLM must pass brand_logo_storage_key
  // explicitly (still works, just no forgot-the-param safety net).
  // #1973 — declared as `optional_requires: memoryStore@1`, which adds no
  // install prerequisite and no ordering edge, so it is resolved at first use
  // (ADR-0053). Any `memoryStore@1` provider serves it (file or Postgres).
  const resolveMemoryStore = (): DiagramBrandMemory | undefined =>
    ctx.services.getOptional<DiagramBrandMemory>('memoryStore');
  // #1961 (ADR-0177): renders are filed per turn. The kernel publishes its
  // `turnContext` accessor as a service; resolved at call time, because the
  // tool call and the end-of-turn drain both run inside the turn.
  const currentTurnId = (): string | undefined =>
    ctx.services.get<TurnIdSource>('turnContext')?.currentTurnId();
  const tool = new DiagramTool(
    service,
    resolveMemoryStore,
    (msg) => ctx.log(msg),
    undefined,
    currentTurnId,
  );

  const disposeTool = ctx.tools.register(
    diagramToolSpec,
    (input) => tool.handle(input),
    {
      promptDoc: SYSTEM_PROMPT_DOC,
      ...(krokiInternal ? { sideEffects: 'none' as const } : {}),
      // Drains only the finishing turn's renders (#1961).
      attachmentSink: (): NativeToolAttachment[] | undefined => {
        const renders = tool.takeRenders(currentTurnId());
        if (!renders) return undefined;
        return renders.map((render) => ({
          kind: 'diagram',
          payload: {
            url: render.url,
            altText: render.title ?? `${render.kind} diagram`,
            diagramKind: render.kind,
            cacheHit: render.cacheHit,
          },
        }));
      },
    },
  );

  const router = createDiagramsRouter({ store, secret: signingSecret });
  // `auth: 'custom'` — same posture as `@omadia/plugin-office`'s `/documents`:
  // the router verifies the HMAC-signed, expiring URL on every request, and
  // the channel users who open these PNG links have no operator session. Only
  // served session-less once the operator grants `/diagrams/dl` (manifest
  // `permissions.public_paths`, Store → plugin → "Grants"); before that the
  // prefix is closed — `404 public_path.not_granted` for everyone.
  // `/dl` because a public-path claim must be at least two segments deep.
  const disposeRoute = ctx.routes.register('/diagrams/dl', router, {
    auth: 'custom',
  });

  ctx.log(
    `[diagrams] ready (kroki=${krokiBaseUrl}${krokiInternal ? ' internal' : ' external'}, bucket=${tigrisBucket}, tenant=${tenantId})`,
  );

  return {
    async close(): Promise<void> {
      ctx.log('deactivating diagrams plugin');
      disposeTool();
      disposeRoute();
      disposeDeleter?.();
    },
  };
}
