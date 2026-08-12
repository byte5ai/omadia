export { activate } from './plugin.js';
export type { OfficePluginHandle } from './plugin.js';
export {
  CREATE_DOCX_TOOL_NAME,
  CREATE_XLSX_TOOL_NAME,
  OfficeTool,
  createDocxToolSpec,
  createXlsxToolSpec,
} from './officeTool.js';
export { OfficeService } from './officeService.js';
export type { OfficeServiceOptions } from './officeService.js';
export { renderXlsx } from './xlsxRenderer.js';
export { renderDocx } from './docxRenderer.js';
export { createDocumentsRouter } from './documentsRouter.js';
export { signDocumentUrl, verifyDocumentSig } from './signing.js';
export { sanitizeFilename } from './filename.js';
// The machine-readable provenance contract a downstream reader branches on
// (property names/values embedded in every generated file, and the free-text
// core-property strings). `PROVENANCE_CUSTOM_PROPERTIES` is a docx-only
// assembly detail and stays internal to the package.
export {
  PROVENANCE_CATEGORY,
  PROVENANCE_DESCRIPTION,
  PROVENANCE_GENERATOR,
  PROVENANCE_KEYWORDS,
  PROVENANCE_PROP_AI_GENERATED,
  PROVENANCE_PROP_GENERATOR,
  PROVENANCE_PROP_STANDARD,
  PROVENANCE_STANDARD,
} from './provenance.js';
export {
  DocxDescriptorSchema,
  XlsxDescriptorSchema,
  XlsxToolInputSchema,
  XlsxToolSheetSchema,
  MEDIA_TYPE,
  OfficePostconditionError,
  OfficeRenderError,
} from './types.js';
export type {
  DocxDescriptor,
  OfficeArtifact,
  OfficeDatasetResolver,
  OfficeFileAttachmentPayload,
  OfficeResolvedDataset,
  RenderResult,
  XlsxDescriptor,
  XlsxToolInput,
} from './types.js';
export type { OfficeToolOptions } from './officeTool.js';
