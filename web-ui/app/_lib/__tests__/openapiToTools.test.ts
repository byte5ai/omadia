import { describe, expect, it } from 'vitest';

import { mapJsonSchemaArray, mapOpenAPI } from '../openapiToTools';

describe('mapOpenAPI', () => {
  it('rejects non-objects with a root error', () => {
    const result = mapOpenAPI('not an object');
    expect(result.tools).toEqual([]);
    expect(result.errors[0]?.path).toBe('<root>');
  });

  it('warns when paths is missing', () => {
    const result = mapOpenAPI({ openapi: '3.0.0' });
    expect(result.tools).toEqual([]);
    expect(result.errors.some((e) => /paths fehlt/.test(e.reason))).toBe(true);
  });

  it('maps a GET with query params into a snake_case tool id', () => {
    const result = mapOpenAPI({
      openapi: '3.0.3',
      paths: {
        '/things': {
          get: {
            operationId: 'listThings',
            summary: 'Lists things.',
            parameters: [
              {
                name: 'limit',
                in: 'query',
                required: true,
                schema: { type: 'integer', minimum: 1, maximum: 50 },
              },
              {
                name: 'cursor',
                in: 'query',
                schema: { type: 'string' },
              },
            ],
          },
        },
      },
    });
    expect(result.errors).toEqual([]);
    expect(result.tools).toHaveLength(1);
    const tool = result.tools[0];
    expect(tool?.id).toBe('list_things');
    expect(tool?.description).toBe('Lists things.');
    const input = tool?.input as {
      type: string;
      properties: Record<string, { type: string }>;
      required: string[];
    };
    expect(input.type).toBe('object');
    expect(input.properties['limit']?.type).toBe('integer');
    expect(input.required).toContain('limit');
    expect(input.required).not.toContain('cursor');
  });

  it('flattens requestBody.application/json into the input schema', () => {
    const result = mapOpenAPI({
      openapi: '3.0.3',
      paths: {
        '/things': {
          post: {
            operationId: 'createThing',
            summary: 'Creates a thing.',
            requestBody: {
              required: true,
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      name: { type: 'string' },
                    },
                    required: ['name'],
                  },
                },
              },
            },
          },
        },
      },
    });
    expect(result.tools).toHaveLength(1);
    const input = result.tools[0]?.input as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(input.properties['name']).toBeDefined();
    expect(input.required).toContain('name');
  });

  it('reports an error and skips the operation when summary+description are missing', () => {
    const result = mapOpenAPI({
      openapi: '3.0.3',
      paths: {
        '/x': { get: { operationId: 'noDocs' } },
      },
    });
    expect(result.tools).toEqual([]);
    expect(result.errors.some((e) => /summary/.test(e.reason))).toBe(true);
  });
});

describe('mapJsonSchemaArray', () => {
  it('rejects non-arrays with a root error', () => {
    expect(mapJsonSchemaArray({ not: 'array' }).errors[0]?.path).toBe(
      '<root>',
    );
  });

  it('maps each entry into a ToolSpec, skipping invalid rows', () => {
    const result = mapJsonSchemaArray([
      { id: 'foo', description: 'bar' },
      { id: '', description: 'invalid' },
      { id: 'baz', description: '' },
      {
        id: 'qux',
        description: 'with input',
        input: { type: 'object', properties: {} },
      },
    ]);
    expect(result.tools).toHaveLength(2);
    expect(result.tools.map((t) => t.id)).toEqual(['foo', 'qux']);
    expect(result.errors).toHaveLength(2);
  });
});
