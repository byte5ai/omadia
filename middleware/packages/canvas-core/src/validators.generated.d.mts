// Hand-written declarations for the generated standalone Ajv validators
// (tools/gen-validator/genValidator.ts).
import type { ErrorObject } from 'ajv/dist/2020.js';

export type StandaloneValidate = ((data: unknown) => boolean) & {
  errors?: ErrorObject[] | null;
};

export declare const validateTree: StandaloneValidate;
export declare const validateSurfaceEvent: StandaloneValidate;
