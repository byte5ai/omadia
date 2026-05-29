import {
  PRIVACY_REDACT_SERVICE_NAME,
  type NativeToolAttachment,
  type PluginContext,
  type PrivacyGuardService,
} from '@omadia/plugin-api';
import { createTigrisStore } from '@omadia/diagrams';
import { turnContext } from '@omadia/orchestrator';

import { createDocumentsRouter } from './documentsRouter.js';
import { OfficeService } from './officeService.js';
import {
  OfficeTool,
  createDocxToolSpec,
  createXlsxToolSpec,
} from './officeTool.js';

/**
 * @omadia/plugin-office — Headless Office: deterministic .xlsx/.docx
 * generation as native tools.
 *
 * Wires the OfficeService (renderers + Tigris signed-URL store), exposes
 * `create_xlsx` + `create_docx` as native tools and mounts `/documents/<signed-key>`
 * as an Express route. Mirrors `@omadia/diagrams` 1:1 — the only structural
 * difference is that produced bytes are files (kind: 'file' attachments) rather
 * than inline images.
 *
 * Required config (via ctx.config):
 *   - public_base_url          absolute origin the middleware is served on
 *   - tigris_bucket            object-storage bucket name
 *   - tigris_endpoint          e.g. `https://fly.storage.tigris.dev`
 *
 * Optional config:
 *   - tenant_id                key prefix; default `dev`
 *   - signed_url_ttl_sec       default 3600
 *   - max_rows                 per-document row cap; default 100000
 *
 * Required secrets (via ctx.secrets):
 *   - document_url_secret      HMAC key for signed URLs (>= 32 bytes)
 *   - aws_access_key_id        Tigris access key
 *   - aws_secret_access_key    Tigris secret key
 */

const SYSTEM_PROMPT_DOC = `\`create_xlsx\` / \`create_docx\`: Erzeugen eine Excel- bzw. Word-Datei aus strukturierten Daten und liefern eine signierte Download-URL, die automatisch als Datei-Anhang an die Antwort gehängt wird. Nutze \`create_xlsx\` wenn der User eine Tabelle/Liste/Excel **als Datei** will (Spalten + Zeilen; setze \`type\` je Spalte für echte Zahlen-/Währungs-/Datumsformate), \`create_docx\` für Berichte/Memos **als Datei**. **Hat ein Fach-Agent einen Datensatz (\`datasetId\`) zurückgegeben und der User will ihn als Datei/Excel herunterladen: ruf \`create_xlsx\` mit \`sheets[].datasetId\` auf — NICHT \`v4_render_answer\` (das ist nur für Text-Antworten im Chat). Die echten Zeilen werden server-seitig in die Datei aufgelöst.** Für Summen/Pivots/Monatsverteilungen nutze Formel-Zellen ({"formula":"SUMMEWENNS(...)"}, Cross-Sheet über Blattname erlaubt) — z.B. Sheet 1 = Daten, Sheet 2 = Formel-Pivot auf Sheet 1. Auf einem Dataset-Sheet darfst du eine berechnete Hilfsspalte ergänzen (columns[].formula mit {row}, z.B. Monat = TEXT(C{row}, JJJJ-MM)). **Wichtig: Wenn der User eine Datei will, ruf das Tool tatsächlich auf — beschreibe nicht nur den Plan. Gibt das Tool ein Error-Ergebnis zurück, behaupte KEINEN Erfolg und verspreche keinen Download — sag dem User knapp, dass und warum die Datei nicht erzeugt werden konnte.** **Zitiere die zurückgegebene URL nicht** im Antworttext — schreib einen kurzen Satz wie "Hier deine Datei:" und lass den Anhang die Datei tragen.`;

export interface OfficePluginHandle {
  close(): Promise<void>;
}

export async function activate(ctx: PluginContext): Promise<OfficePluginHandle> {
  ctx.log('activating office plugin');

  const publicBaseUrl = ctx.config.require<string>('public_base_url');
  const tigrisBucket = ctx.config.require<string>('tigris_bucket');
  const tigrisEndpoint = ctx.config.require<string>('tigris_endpoint');
  const tenantId = ctx.config.get<string>('tenant_id') ?? 'dev';
  const signedUrlTtlSec = ctx.config.get<number>('signed_url_ttl_sec') ?? 3600;
  const maxRows = ctx.config.get<number>('max_rows') ?? 100_000;

  const signingSecret = await ctx.secrets.require('document_url_secret');
  const awsAccessKeyId = await ctx.secrets.require('aws_access_key_id');
  const awsSecretAccessKey = await ctx.secrets.require('aws_secret_access_key');

  const store = createTigrisStore({
    endpoint: tigrisEndpoint,
    accessKeyId: awsAccessKeyId,
    secretAccessKey: awsSecretAccessKey,
    bucket: tigrisBucket,
  });
  const service = new OfficeService({
    store,
    secret: signingSecret,
    publicBaseUrl,
    tenantId,
    signedUrlTtlSec,
    log: (msg) => ctx.log(msg),
  });
  // Dataset rendering (M3): resolve a datasetId → real rows server-side within
  // the current turn. turnContext gives the turnId; the privacy store is keyed
  // by it and shared across the sub-agent boundary, so a dataset an Odoo
  // sub-agent interned this turn is resolvable here.
  //
  // The privacy provider is resolved LAZILY (per tool call), not captured here:
  // plugin activation order is not guaranteed (this plugin declares no
  // depends_on on privacy-guard), so a capture at activate() time can miss a
  // provider that activates afterwards. By tool-call time all plugins are up.
  const tool = new OfficeTool(service, maxRows, {
    log: (msg) => ctx.log(msg),
    currentTurnId: () => turnContext.current()?.turnId,
    getPrivacyResolver: () => {
      const privacy = ctx.services.get<PrivacyGuardService>(PRIVACY_REDACT_SERVICE_NAME);
      return privacy?.resolveDatasetForRender !== undefined
        ? (turnId: string, datasetId: string) =>
            privacy.resolveDatasetForRender!(turnId, datasetId)
        : undefined;
    },
  });

  const disposeXlsx = ctx.tools.register(
    createXlsxToolSpec,
    (input) => tool.handleXlsx(input),
    {
      promptDoc: SYSTEM_PROMPT_DOC,
      // Single drain for BOTH tools — see OfficeTool doc. The kernel calls
      // every tool's sink once per turn; a second sink would double-drain.
      attachmentSink: (): NativeToolAttachment[] | undefined => tool.drain(),
    },
  );
  const disposeDocx = ctx.tools.register(
    createDocxToolSpec,
    (input) => tool.handleDocx(input),
  );

  const router = createDocumentsRouter({ store, secret: signingSecret });
  const disposeRoute = ctx.routes.register('/documents', router);

  ctx.log(
    `[office] ready (bucket=${tigrisBucket}, tenant=${tenantId}, dataset=lazy, privacyNow=${ctx.services.has(PRIVACY_REDACT_SERVICE_NAME) ? 'yes' : 'not-yet'})`,
  );

  return {
    async close(): Promise<void> {
      ctx.log('deactivating office plugin');
      disposeXlsx();
      disposeDocx();
      disposeRoute();
    },
  };
}
