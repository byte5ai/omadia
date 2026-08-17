/**
 * `json_file` setup fields — server-side extraction (issue #603, OM-17).
 *
 * ## What this exists to prevent
 *
 * The first customer test produced a near-miss: a tester typed their real Google
 * account password into `gw_sa_private_key`. Nothing about them was careless —
 * the form asked them to hand-transcribe two values out of a service-account
 * JSON key file into an email field and a masked field stacked directly beneath
 * it, which is the visual pattern of a login. #599 added a caution and `pattern`
 * validation, so the mistake is now *detected*. Uploading the file removes the
 * opportunity to make it.
 *
 * The tester named this fix themselves, and they were right: it is structural,
 * and it saves a step rather than adding one.
 *
 * ## Why the parsing is here and not in the browser
 *
 * A `json_file` field never reaches storage as a file. The client posts the
 * file's text, the server parses it, validates it, explodes it into the
 * underlying keys, and stores ONLY the derived values. The browser is not
 * trusted to do the extraction, because a client that decides which bytes become
 * `gw_sa_private_key` is a client that can be made to decide wrongly.
 *
 * Downstream, nothing else changes: the derived fields stay ordinary `secret`
 * fields for readiness, vault storage and rotation. `json_file` is an INPUT
 * affordance, not a new kind of credential.
 *
 * ## Path syntax — a deliberate subset
 *
 * `extracts` maps a target key to `$.a.b`: a `$` root followed by dot-separated
 * object keys. Not JSONPath. Service-account files are flat records and the full
 * grammar (filters, wildcards, recursive descent, scripts) would add a
 * dependency and an evaluation surface to parse an operator-supplied string
 * against operator-supplied data — for no case anyone has. A manifest asking for
 * more than this fails loudly at load time rather than silently matching nothing.
 */

/** Hard ceiling on an uploaded key file. Service-account keys are ~2.3 KB; this
 *  leaves generous room while keeping a hostile upload from reaching `JSON.parse`
 *  at all. Checked on the RAW text, before parsing. */
export const JSON_FILE_MAX_BYTES = 64 * 1024;

/** Cap on how many values one field may explode into. Bounds both the response
 *  and the number of vault writes a single upload can trigger. */
export const JSON_FILE_MAX_EXTRACTS = 16;

/** The `json_file` half of a setup-field declaration. */
export interface JsonFileFieldSpec {
  /** The `json_file` field's own key. Never stored — it names the upload, not a
   *  secret. */
  readonly key: string;
  /** target setup-field key → `$.dotted.path` into the uploaded document. */
  readonly extracts: Readonly<Record<string, string>>;
  /** Shallow equality assertions against the document, e.g.
   *  `{ type: 'service_account' }`. Catches the wrong file before any value is
   *  extracted — an OAuth client secret and a service-account key look alike
   *  enough to confuse at a glance. */
  readonly expect?: Readonly<Record<string, unknown>>;
}

/** The discriminant of {@link JsonFileFailure}. Exported so a caller can map
 *  every kind exhaustively — the route does, so a new kind cannot ship without
 *  a wire code and operator help copy. */
export type JsonFileFailureCode =
  | 'too_large'
  | 'not_json'
  | 'not_an_object'
  | 'unexpected_document'
  | 'bad_extract_path'
  | 'missing_value'
  | 'invalid_spec';

export type JsonFileFailure =
  | { readonly code: 'too_large'; readonly message: string }
  | { readonly code: 'not_json'; readonly message: string }
  | { readonly code: 'not_an_object'; readonly message: string }
  | { readonly code: 'unexpected_document'; readonly message: string }
  | { readonly code: 'bad_extract_path'; readonly message: string }
  | { readonly code: 'missing_value'; readonly message: string }
  | { readonly code: 'invalid_spec'; readonly message: string };

export type JsonFileOutcome =
  | { readonly ok: true; readonly values: Record<string, string> }
  | { readonly ok: false; readonly failure: JsonFileFailure };

const PATH_RE = /^\$(?:\.[A-Za-z_][A-Za-z0-9_-]*)+$/;

/**
 * Resolve `$.a.b` against `doc`. Returns `undefined` for any miss — a missing
 * segment, a non-object on the way down, or an inherited property.
 *
 * `Object.hasOwn` matters: without it `$.constructor` resolves through the
 * prototype chain and a manifest could extract a function into a secret.
 */
function resolvePath(doc: Record<string, unknown>, path: string): unknown {
  const segments = path.slice(2).split('.');
  let node: unknown = doc;
  for (const segment of segments) {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) {
      return undefined;
    }
    if (!Object.hasOwn(node as object, segment)) return undefined;
    node = (node as Record<string, unknown>)[segment];
  }
  return node;
}

/** Render a value for an `expect` mismatch message. Only ever called on the
 *  DECLARED expectation and on scalars from the document that the operator
 *  chose to assert on — never on an extracted secret. */
function describe(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (value === null || ['number', 'boolean'].includes(typeof value)) {
    return String(value);
  }
  return typeof value;
}

/**
 * Parse an uploaded document and produce the derived setup values.
 *
 * On success the caller receives ONLY the extracted values. `raw` is never
 * returned, never logged, and must never be persisted — the whole point is that
 * the file itself does not become state.
 *
 * Every failure names what is wrong in a sentence an operator can act on. A
 * silent empty secret is the one outcome this must never produce: it would look
 * like a successful setup and fail later, far from the cause.
 */
export function extractFromJsonFile(
  raw: string,
  spec: JsonFileFieldSpec,
): JsonFileOutcome {
  const entries = Object.entries(spec.extracts ?? {});
  if (entries.length === 0) {
    return {
      ok: false,
      failure: {
        code: 'invalid_spec',
        message: `Setup field '${spec.key}' declares no 'extracts', so the upload could not produce any value.`,
      },
    };
  }
  if (entries.length > JSON_FILE_MAX_EXTRACTS) {
    return {
      ok: false,
      failure: {
        code: 'invalid_spec',
        message: `Setup field '${spec.key}' declares ${String(entries.length)} extracts; at most ${String(JSON_FILE_MAX_EXTRACTS)} are allowed.`,
      },
    };
  }

  // Size is checked on the raw text, BEFORE parsing: the cap exists so a hostile
  // upload never reaches `JSON.parse` in the first place.
  const bytes = Buffer.byteLength(raw, 'utf8');
  if (bytes > JSON_FILE_MAX_BYTES) {
    return {
      ok: false,
      failure: {
        code: 'too_large',
        message: `The uploaded file is ${String(bytes)} bytes; the limit is ${String(JSON_FILE_MAX_BYTES)}.`,
      },
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      ok: false,
      failure: {
        code: 'not_json',
        message: 'The uploaded file is not valid JSON.',
      },
    };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      ok: false,
      failure: {
        code: 'not_an_object',
        message: 'The uploaded file must contain a JSON object.',
      },
    };
  }
  const doc = parsed as Record<string, unknown>;

  // `expect` runs BEFORE extraction, so the wrong file is rejected without any
  // value being pulled out of it.
  for (const [key, want] of Object.entries(spec.expect ?? {})) {
    const got = Object.hasOwn(doc, key) ? doc[key] : undefined;
    if (got !== want) {
      return {
        ok: false,
        failure: {
          code: 'unexpected_document',
          message:
            `This does not look like the expected file: '${key}' is ` +
            `${got === undefined ? 'missing' : describe(got)}, expected ${describe(want)}.`,
        },
      };
    }
  }

  const values: Record<string, string> = {};
  for (const [target, path] of entries) {
    if (!PATH_RE.test(path)) {
      return {
        ok: false,
        failure: {
          code: 'bad_extract_path',
          message: `Setup field '${spec.key}' declares an unsupported extract path '${path}' for '${target}'. Use '$.key' or '$.nested.key'.`,
        },
      };
    }
    const found = resolvePath(doc, path);
    // Only strings become secrets. A number or object at the path means the
    // manifest and the file disagree about the shape, which is a setup error,
    // not something to coerce.
    if (typeof found !== 'string' || found === '') {
      return {
        ok: false,
        failure: {
          code: 'missing_value',
          message:
            `The uploaded file has no usable value at '${path}' (needed for '${target}'). ` +
            'Check that you selected the right file.',
        },
      };
    }
    values[target] = found;
  }
  return { ok: true, values };
}
