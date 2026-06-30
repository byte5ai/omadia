// Structural (ajv) validation of the workflow graph shape. ajv is the sole runtime
// dependency. `conductorGraphSchema` is the single source of truth; the published
// schema/conductor-graph.schema.json is asserted structurally equal by a test.

import { Ajv2020 } from 'ajv/dist/2020.js';

/** JSON Schema (draft 2020-12) for the workflow graph persisted as
 *  `conductor_workflow_versions.graph`. */
export const conductorGraphSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://omadia.ai/schema/conductor-graph.schema.json',
  title: 'Conductor Workflow Graph',
  type: 'object',
  required: ['entryStepId', 'steps', 'transitions'],
  additionalProperties: false,
  properties: {
    entryStepId: { type: 'string', minLength: 1 },
    steps: { type: 'array', items: { $ref: '#/$defs/step' } },
    transitions: { type: 'array', items: { $ref: '#/$defs/transition' } },
    triggers: { type: 'array', items: { $ref: '#/$defs/trigger' } },
  },
  $defs: {
    step: {
      type: 'object',
      required: ['id', 'kind'],
      additionalProperties: false,
      properties: {
        id: { type: 'string', minLength: 1 },
        kind: { enum: ['agent', 'action', 'human'] },
        agentId: { type: 'string' },
        actionId: { type: 'string' },
        prompt: { type: 'string' },
        input: { type: 'object' },
        human: { $ref: '#/$defs/human' },
        postcondition: { $ref: '#/$defs/predicate' },
        fallbackTransitionId: { type: 'string' },
        position: {
          type: 'object',
          properties: { x: { type: 'number' }, y: { type: 'number' } },
        },
      },
    },
    human: {
      type: 'object',
      required: ['principal', 'channel', 'message'],
      additionalProperties: false,
      properties: {
        principal: {
          type: 'object',
          required: ['kind', 'ref'],
          additionalProperties: false,
          properties: {
            kind: { enum: ['user', 'role'] },
            ref: { type: 'string', minLength: 1 },
          },
        },
        channel: { type: 'string', minLength: 1 },
        message: { type: 'string' },
        reminderInterval: { type: ['string', 'null'] },
        deadline: { type: ['string', 'null'] },
        quorum: { enum: ['any', 'all'] },
        responseSchema: { type: 'object' },
      },
    },
    transition: {
      type: 'object',
      required: ['id', 'source', 'target'],
      additionalProperties: false,
      properties: {
        id: { type: 'string', minLength: 1 },
        source: { type: 'string', minLength: 1 },
        target: { type: 'string', minLength: 1 },
        guard: { $ref: '#/$defs/predicate' },
      },
    },
    trigger: {
      type: 'object',
      required: ['id', 'kind'],
      additionalProperties: false,
      properties: {
        id: { type: 'string', minLength: 1 },
        kind: { enum: ['manual', 'cron', 'channel', 'agent', 'webhook', 'workflow', 'event'] },
        eventId: { type: 'string' },
        filter: { $ref: '#/$defs/predicate' },
        cron: { type: 'string' },
      },
    },
    predicate: {
      type: 'object',
      required: ['op'],
      additionalProperties: false,
      properties: {
        op: {
          enum: ['eq', 'ne', 'gt', 'lt', 'gte', 'lte', 'exists', 'in', 'matches', 'and', 'or', 'not', 'always', 'never'],
        },
        path: { type: 'string' },
        value: true,
        args: { type: 'array', items: { $ref: '#/$defs/predicate' } },
        arg: { $ref: '#/$defs/predicate' },
      },
    },
  },
} as const;

const ajv = new Ajv2020({ allErrors: true, strict: false });
const validateFn = ajv.compile(conductorGraphSchema as unknown as object);

export interface ShapeResult {
  ok: boolean;
  errors: string[];
}

/** Validate the structural shape of an unknown value against the graph schema. */
export function validateGraphShape(graph: unknown): ShapeResult {
  const ok = validateFn(graph) as boolean;
  if (ok) return { ok: true, errors: [] };
  const errs = (validateFn.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? 'invalid'}`);
  return { ok: false, errors: errs };
}
