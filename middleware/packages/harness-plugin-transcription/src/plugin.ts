import type { PluginContext } from '@omadia/plugin-api';

import {
  createTranscriptionUploadRouter,
  type TranscriptionUploadStore,
} from './uploadRouter.js';

/**
 * @omadia/plugin-transcription — audio ingestion for the `transcription@1`
 * capability (#584, Workstream I).
 *
 * Current scope: mounts the operator-only multipart upload endpoint under
 * `/transcriptions` (see `uploadRouter.ts` for the full contract). The
 * explicit `transcribe_recording` tool, Transcript Artifact, session
 * projection and privacy wiring follow in this same package so the
 * whole ingestion path ships as one plugin and core stays
 * untouched (ADR-0003 spirit).
 *
 * The blob store is the kernel-published `tigrisStore` service, resolved
 * LAZILY (per request), not captured at activate(): the service is only
 * registered when blob storage is configured, and this plugin must degrade
 * (503 on upload) instead of failing activation on a storage-less install.
 */

export interface TranscriptionPluginHandle {
  close(): Promise<void>;
}

export async function activate(
  ctx: PluginContext,
): Promise<TranscriptionPluginHandle> {
  ctx.log('activating transcription ingestion plugin');

  const router = createTranscriptionUploadRouter({
    operatorAuth: ctx.operatorAuth,
    getStore: () => ctx.services.get<TranscriptionUploadStore>('tigrisStore'),
    log: (msg) => ctx.log(msg),
  });
  const disposeRoute = ctx.routes.register('/transcriptions', router);

  ctx.log(
    `[transcription] upload endpoint mounted at /transcriptions (operatorAuth=${
      ctx.operatorAuth ? 'wired' : 'MISSING — serving 503 fail-closed'
    })`,
  );

  return {
    async close(): Promise<void> {
      ctx.log('deactivating transcription ingestion plugin');
      disposeRoute();
    },
  };
}
