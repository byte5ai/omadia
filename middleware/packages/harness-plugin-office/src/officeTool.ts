import type { NativeToolAttachment, NativeToolSpec } from '@omadia/plugin-api';
import type { OfficeService } from './officeService.js';
import {
  DocxDescriptorSchema,
  XlsxToolInputSchema,
  type CellValue,
  type ColumnSpec,
  type OfficeArtifact,
  type OfficeDatasetResolver,
  type OfficeFileAttachmentPayload,
  type OfficeResolvedDataset,
  type XlsxDescriptor,
} from './types.js';

export const CREATE_XLSX_TOOL_NAME = 'create_xlsx';
export const CREATE_DOCX_TOOL_NAME = 'create_docx';

export const createXlsxToolSpec: NativeToolSpec = {
  name: CREATE_XLSX_TOOL_NAME,
  description:
    'Erzeugt eine Excel-Datei (.xlsx) und gibt eine signierte Download-URL zurück, die als Datei-Anhang an die Antwort gehängt wird. Nutze es, wenn der User eine Excel/Tabelle/Liste **als Datei** will. Jedes `sheet` hat `columns` (key+header, optional `type` für Zahlenformate) und genau EINE Datenquelle: entweder `rows` (Daten, die DU zusammenstellst) ODER `datasetId` (ein server-seitiger Datensatz, dessen Id du in der Daten-Übersicht eines Fach-Agenten gesehen hast — z.B. „alle offenen Posten"). Bei `datasetId` wandern die echten Zeilen NICHT durch dich: der Server löst die Id auf und rendert sie; setze nur `columns` (key = Feldpfad aus dem Datensatz-Schema) für Auswahl/Reihenfolge/Format. Setze `type:"currency"`/`"date"`/`"number"`, damit Excel echte Werte speichert. **Wenn ein Fach-Agent einen Datensatz (datasetId) geliefert hat und der User ihn als Datei/Excel/Download will, ruf `create_xlsx` mit dieser `datasetId` — NICHT `v4_render_answer` (das erzeugt nur eine Text-Antwort im Chat).** **Berechnungen/Pivots:** als Zellwert ist auch eine Formel erlaubt: `{"formula":"SUMMEWENNS(\'Offene Posten\'!E:E, \'Offene Posten\'!C:C, A2)"}` — inkl. Cross-Sheet-Referenz über den Blattnamen. Spalten liegen in Reihenfolge auf A, B, C…; typischer Aufbau: Sheet 1 = Daten (datasetId), Sheet 2 = Pivot mit Formeln auf Sheet 1. Auf einem Dataset-Sheet kannst du zusätzlich eine berechnete Spalte ergänzen (columns[].formula mit {row}-Platzhalter für die Zeilennummer), z.B. eine Monat-Hilfsspalte, und Sheet 2 darauf referenzieren. **Unterstützt:** mehrere Sheets, Zahlenformate, Inline-Werte, Formeln (inkl. Cross-Sheet). **NICHT unterstützt:** echte Excel-PivotTables, Diagramme, Bilder — baue Pivots als Formel-Summary (SUMMEWENNS). **Wenn du eine Datei erstellst, ruf dieses Tool tatsächlich auf — beschreibe nicht nur den Plan. Gibt das Tool `Error:` zurück, behaupte KEINEN Erfolg und verspreche keinen Download — sag dem User knapp, dass/warum die Datei nicht erzeugt werden konnte.** **Zitiere die URL nicht** im Antworttext — schreib z.B. "Hier deine Excel-Datei:".',
  input_schema: {
    type: 'object',
    properties: {
      filename: {
        type: 'string',
        description: 'Optionaler Dateiname ohne Pfad, z.B. "offene-posten". Endung wird ergänzt.',
      },
      title: { type: 'string', description: 'Optionaler Dokumenttitel (Metadaten).' },
      sheets: {
        type: 'array',
        description: 'Mindestens ein Arbeitsblatt.',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Blattname (max. 31 Zeichen).' },
            columns: {
              type: 'array',
              description: 'Spaltendefinitionen in Anzeigereihenfolge.',
              items: {
                type: 'object',
                properties: {
                  key: {
                    type: 'string',
                    description:
                      'Schlüssel, unter dem die Zeile den Wert führt. Bei datasetId = Feldpfad aus dem Datensatz-Schema.',
                  },
                  header: { type: 'string', description: 'Spaltenüberschrift.' },
                  type: {
                    type: 'string',
                    enum: ['text', 'number', 'currency', 'date', 'percent'],
                    description: 'Treibt das Excel-Zahlenformat. percent erwartet Bruch (0.125 = 12,5%).',
                  },
                  width: { type: 'number', description: 'Spaltenbreite in Zeichen.' },
                  numFmt: { type: 'string', description: 'Explizites Excel-Format, überschreibt type.' },
                  currency: { type: 'string', description: 'ISO-Währung für type:currency, Default EUR.' },
                  formula: {
                    type: 'string',
                    description:
                      'Berechnete Spalte: per-Zeile-Formel, `{row}` = Zeilennummer. Funktioniert AUCH auf Dataset-Sheets (Hilfsspalte), z.B. "TEXT(C{row},\\"JJJJ-MM\\")". Andere Spalten per Excel-Buchstabe (A,B,C… in Reihenfolge) referenzieren.',
                  },
                },
                required: ['key', 'header'],
              },
            },
            rows: {
              type: 'array',
              description:
                'Inline-Daten (M1): Zeilen als Objekte, je Spalten-`key` ein Wert: string|number|boolean|null ODER eine Formel-Zelle `{"formula":"SUMMEWENNS(...)"}` (Cross-Sheet-Ref über Blattname erlaubt). Genau eines von rows/datasetId.',
              items: { type: 'object', additionalProperties: true },
            },
            datasetId: {
              type: 'string',
              description:
                'Server-seitiger Datensatz (M3): die Id aus der Daten-Übersicht eines Fach-Agenten. Die echten Zeilen werden server-seitig aufgelöst. Genau eines von rows/datasetId.',
            },
          },
          required: ['name', 'columns'],
        },
      },
    },
    required: ['sheets'],
  },
};

export const createDocxToolSpec: NativeToolSpec = {
  name: CREATE_DOCX_TOOL_NAME,
  description:
    'Erzeugt ein Word-Dokument (.docx) aus strukturierten Blöcken und gibt eine signierte Download-URL zurück, die als Datei-Anhang angehängt wird. Nutze es für Berichte/Memos/Briefe **als Datei**. `blocks` ist eine Liste mit `type`: "heading" (level 1-4, text), "paragraph" (text), "bullets" (items[]), "table" (headers[], rows[][]). **Zitiere die URL nicht** im Antworttext.',
  input_schema: {
    type: 'object',
    properties: {
      filename: { type: 'string', description: 'Optionaler Dateiname ohne Pfad.' },
      title: { type: 'string', description: 'Optionaler Titel (als Titel-Absatz + Metadaten).' },
      blocks: {
        type: 'array',
        description:
          'Inhaltsblöcke in Reihenfolge. Jeder Block hat `type` und die dazu passenden Felder: heading{level,text}, paragraph{text}, bullets{items[]}, table{headers[],rows[][]}.',
        items: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['heading', 'paragraph', 'bullets', 'table'] },
            level: { type: 'number', description: 'Nur heading: 1-4.' },
            text: { type: 'string', description: 'Für heading/paragraph.' },
            items: { type: 'array', items: { type: 'string' }, description: 'Nur bullets.' },
            headers: { type: 'array', items: { type: 'string' }, description: 'Nur table.' },
            rows: {
              type: 'array',
              items: { type: 'array', items: { type: 'string' } },
              description: 'Nur table: Zeilen als String-Arrays, Spaltenreihenfolge wie headers.',
            },
          },
          required: ['type'],
        },
      },
    },
    required: ['blocks'],
  },
};

export interface OfficeToolOptions {
  readonly log?: (msg: string) => void;
  /** Returns the current turn's id (from the orchestrator's turnContext), so
   *  dataset resolution is scoped to this turn. Undefined → no active turn. */
  readonly currentTurnId?: () => string | undefined;
  /** Returns the dataset resolver, resolved LAZILY at tool-call time. Lazy on
   *  purpose: the privacy provider may activate after this plugin (no
   *  depends_on ordering guarantee), so capturing it at activate() time would
   *  miss it. Returns undefined when no privacy provider is installed. */
  readonly getPrivacyResolver?: () => OfficeDatasetResolver | undefined;
}

/**
 * Orchestrator-side wrapper around {@link OfficeService}. Two tools
 * (`create_xlsx`, `create_docx`) share one instance and one pending-attachment
 * buffer; the plugin registers the attachment sink exactly once (on the xlsx
 * tool) so `drain()` runs a single time per turn.
 */
export class OfficeTool {
  private pending: NativeToolAttachment[] = [];
  private readonly log: (msg: string) => void;

  constructor(
    private readonly service: OfficeService,
    private readonly maxRows: number,
    private readonly opts: OfficeToolOptions = {},
  ) {
    this.log = opts.log ?? ((m) => console.error(m));
  }

  async handleXlsx(input: unknown): Promise<string> {
    const parsed = XlsxToolInputSchema.safeParse(input);
    if (!parsed.success) {
      return `Error: invalid create_xlsx input — ${issues(parsed.error)}`;
    }

    // Normalize every sheet to concrete inline rows. Dataset sheets resolve
    // server-side (the real rows never passed through the model). `expectedRows`
    // is the postcondition target — for a dataset it is the dataset's full
    // rowCount, so a truncated/under-delivered render is caught.
    const sheets: XlsxDescriptor['sheets'] = [];
    let expectedRows = 0;
    for (const sheet of parsed.data.sheets) {
      if (sheet.datasetId !== undefined) {
        const resolved = this.resolveDatasetSheet(sheet.datasetId);
        if (typeof resolved === 'string') return resolved; // error message
        expectedRows += resolved.rowCount;
        sheets.push({
          name: sheet.name,
          columns: sheet.columns,
          rows: resolved.rows.map((row) => datasetRowToObject(row, sheet.columns)),
        });
      } else {
        const rows = sheet.rows ?? [];
        expectedRows += rows.length;
        sheets.push({ name: sheet.name, columns: sheet.columns, rows });
      }
    }

    if (expectedRows > this.maxRows) {
      return `Error: too many rows (${String(expectedRows)} > ${String(this.maxRows)}) — narrow the data or split into multiple files.`;
    }

    const descriptor: XlsxDescriptor = {
      ...(parsed.data.filename ? { filename: parsed.data.filename } : {}),
      ...(parsed.data.title ? { title: parsed.data.title } : {}),
      sheets,
    };

    try {
      const artifact = await this.service.createXlsx(descriptor);
      if (artifact.rowsWritten !== expectedRows) {
        return `Error: postcondition failed — wrote ${String(artifact.rowsWritten)} of ${String(expectedRows)} rows`;
      }
      this.pending.push(toAttachment(artifact, 'office.xlsx'));
      return compactResult(artifact);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log(`[office] create_xlsx failed: ${message}`);
      return `Error: ${message}`;
    }
  }

  async handleDocx(input: unknown): Promise<string> {
    const parsed = DocxDescriptorSchema.safeParse(input);
    if (!parsed.success) {
      return `Error: invalid create_docx input — ${issues(parsed.error)}`;
    }
    try {
      const artifact = await this.service.createDocx(parsed.data);
      this.pending.push(toAttachment(artifact, 'office.docx'));
      return compactResult(artifact);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log(`[office] create_docx failed: ${message}`);
      return `Error: ${message}`;
    }
  }

  /** Drains attachments produced this turn and resets the buffer. Registered
   *  once (on the xlsx tool) — see class doc. */
  drain(): NativeToolAttachment[] | undefined {
    if (this.pending.length === 0) return undefined;
    const out = this.pending;
    this.pending = [];
    return out;
  }

  /** Resolve a dataset sheet to real rows, or return an Error: string the
   *  handler forwards to the model. */
  private resolveDatasetSheet(datasetId: string): OfficeResolvedDataset | string {
    const resolver = this.opts.getPrivacyResolver?.();
    const turnId = this.opts.currentTurnId?.();
    if (!resolver) {
      this.log(`[office] dataset-mode datasetId=${datasetId} → privacy provider UNAVAILABLE`);
      return 'Error: dataset rendering is unavailable — privacy provider not installed (use inline rows instead)';
    }
    if (!turnId) {
      this.log(`[office] dataset-mode datasetId=${datasetId} → NO ACTIVE TURN`);
      return 'Error: no active turn — a dataset can only be rendered within the turn that produced it';
    }
    const resolved = resolver(turnId, datasetId);
    this.log(
      `[office] dataset-mode turn=${turnId} datasetId=${datasetId} → ${resolved ? `${String(resolved.rowCount)} rows` : 'NOT FOUND'}`,
    );
    if (!resolved) {
      return `Error: unknown datasetId "${datasetId}" — it expired or was not produced in this turn`;
    }
    return resolved;
  }
}

/** Map a resolved dataset row (keyed by field path, values are `unknown`) to a
 *  renderer row keyed by column key, coercing Odoo-shaped values to cells:
 *  many2one `[id, label]` → label; other arrays/objects → JSON string. */
function datasetRowToObject(
  row: Record<string, unknown>,
  columns: readonly ColumnSpec[],
): Record<string, CellValue> {
  const out: Record<string, CellValue> = {};
  for (const col of columns) {
    out[col.key] = normalizeCell(row[col.key]);
  }
  return out;
}

function normalizeCell(value: unknown): CellValue {
  if (value === null || value === undefined) return null;
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    // Odoo many2one comes back as [id, "Label"] — show the label.
    if (value.length === 2 && typeof value[1] === 'string') return value[1];
    return JSON.stringify(value);
  }
  return JSON.stringify(value);
}

function toAttachment(artifact: OfficeArtifact, producer: string): NativeToolAttachment {
  const payload: OfficeFileAttachmentPayload = {
    url: artifact.url,
    altText: artifact.filename,
    mediaType: artifact.mediaType,
    sizeBytes: artifact.sizeBytes,
    producer,
  };
  return { kind: 'file', payload };
}

function compactResult(artifact: OfficeArtifact): string {
  return JSON.stringify({
    filename: artifact.filename,
    mediaType: artifact.mediaType,
    sizeBytes: artifact.sizeBytes,
    rows: artifact.rowsWritten,
    url: artifact.url,
  });
}

function issues(error: { issues: Array<{ path: PropertyKey[]; message: string }> }): string {
  return error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
}
