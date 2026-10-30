/**
 * #1556 follow-up — the privacy guard's side of the `non_personal_fields`
 * suggestions, wired into the service by `createPrivacyGuardService`.
 *
 * Schema-only observations of masked Odoo fields plus a bounded, TTL'd value
 * sample per field (`fieldObservations.ts`). The sample never leaves the
 * plugin: only detector verdicts (`fieldVetting.ts`) and a fully masked
 * preview do, and nothing here logs a value.
 */

import type {
  FieldObservation,
  FieldSampleVerdict,
  ModelClassificationRequest,
  ModelClassificationResult,
  PromptPiiDetector,
} from '@omadia/plugin-api';

import { withC1Priority } from './c1Detector.js';
import { createFieldObservationRecorder } from './fieldObservations.js';
import { maskedPreview, vetSample } from './fieldVetting.js';
import { classifyModelsSchemaOnly } from './v4/modelClassifier.js';
import type { LlmComplete } from './v4/piiClassifier.js';
import type { Dataset } from './v4/types.js';

export interface FieldClassificationDeps {
  /** The turn's interned dataset, or `undefined`. */
  readonly datasetOf: (turnId: string, datasetId: string) => Dataset | undefined;
  /** Tools whose results are never candidates (sub-agent narration, canvas
   *  producers); the `odoo_` scope is the recorder's own. */
  readonly excludedTools: ReadonlySet<string>;
  /** The operator deny-list detector, resolved per call. */
  readonly customDetector: () => PromptPiiDetector | undefined;
  /** C1 at the near-miss threshold, else at the normal one, while C1 is
   *  configured; `undefined` otherwise. */
  readonly c1Detector: () => PromptPiiDetector | undefined;
  readonly llmComplete?: LlmComplete;
}

export interface FieldClassificationMethods {
  takeFieldObservations(): readonly FieldObservation[];
  vetFieldSample(field: {
    readonly toolName: string;
    readonly fieldPath: string;
  }): Promise<FieldSampleVerdict>;
  classifyModelsSchemaOnly(
    requests: readonly ModelClassificationRequest[],
  ): Promise<readonly ModelClassificationResult[]>;
  maskedFieldPreview(field: {
    readonly toolName: string;
    readonly fieldPath: string;
    readonly limit?: number;
  }): readonly string[];
}

export function createFieldClassificationService(deps: FieldClassificationDeps): {
  /** Observe a just-interned dataset. Never fails the intern; the log line
   *  carries no value. */
  readonly record: (turnId: string, toolName: string, datasetId: string) => void;
  readonly methods: FieldClassificationMethods;
} {
  const observations = createFieldObservationRecorder();

  function record(turnId: string, toolName: string, datasetId: string): void {
    const dataset = deps.datasetOf(turnId, datasetId);
    if (dataset === undefined) return;
    try {
      observations.record(toolName, dataset, deps.excludedTools);
    } catch (err) {
      console.warn(
        `[privacy-guard v4] fieldObservation failed turn=${turnId} tool=${toolName}: ` +
          `${err instanceof Error ? err.name : 'error'}`,
      );
    }
  }

  const methods: FieldClassificationMethods = {
    takeFieldObservations() {
      return observations.take();
    },

    async vetFieldSample(field) {
      const key = { toolName: field.toolName, fieldPath: field.fieldPath };
      const values = observations.sample(key);
      observations.clearSample(key);
      const customDetector = deps.customDetector();
      const c1Base = deps.c1Detector();
      const c1 = c1Base !== undefined ? withC1Priority(c1Base, 'background') : undefined;
      const verdict = await vetSample({
        ...key,
        values,
        ...(customDetector !== undefined ? { customDetector } : {}),
        ...(c1 !== undefined ? { c1Detector: c1 } : {}),
      });
      console.log(
        `[privacy-guard v4] fieldVetted tool=${verdict.toolName} field=${verdict.fieldPath} ` +
          `samples=${String(verdict.sampleCount)} identityHit=${String(verdict.identityHit)} ` +
          `c1=${verdict.c1} types=${JSON.stringify(verdict.hitTypes)}`,
      );
      return verdict;
    },

    async classifyModelsSchemaOnly(requests) {
      return classifyModelsSchemaOnly(requests, deps.llmComplete, (msg) => {
        console.log(msg);
      });
    },

    maskedFieldPreview(field) {
      return maskedPreview(
        observations.sample({ toolName: field.toolName, fieldPath: field.fieldPath }),
        field.limit,
      );
    },
  };

  return { record, methods };
}
