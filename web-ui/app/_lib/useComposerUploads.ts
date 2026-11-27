'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  CHAT_UPLOADS_PER_MESSAGE,
  deleteChatUpload,
  precheckUpload,
  readyUploads,
  uploadChatFile,
  type ComposerUpload,
  type UploadedFile,
} from './chatUploads';

export interface ComposerUploads {
  uploads: readonly ComposerUpload[];
  /** Attach files (picker, drop, paste); each uploads at once. */
  addFiles: (files: readonly File[]) => void;
  remove: (localId: string) => void;
  /** Empties the list after a send. */
  clear: () => void;
  /** Files ready to go with the next message. */
  ready: UploadedFile[];
  /** True while any file is still uploading: sending waits. */
  busy: boolean;
}

const NO_UPLOADS: readonly ComposerUpload[] = [];

interface ListState {
  sessionId: string;
  list: readonly ComposerUpload[];
}

let localCounter = 0;
function nextLocalId(): string {
  localCounter += 1;
  return `upload-${String(Date.now())}-${String(localCounter)}`;
}

/**
 * #2336 — the composer's attachment list for the chat `sessionId`. The list
 * belongs to the chat it was filled in (an upload is bound to that chat,
 * ADR-0310): another chat shows an empty list, and going back shows it again
 * until files are attached in the other chat, which starts a new list.
 * A file removed before sending, or one whose upload finishes after its list
 * is gone, is deleted on the server at once.
 */
export function useComposerUploads(sessionId: string): ComposerUploads {
  const [state, setState] = useState<ListState>({ sessionId, list: NO_UPLOADS });
  const uploads = state.sessionId === sessionId ? state.list : NO_UPLOADS;
  const sessionRef = useRef(sessionId);
  // The state as last rendered plus what `addFiles` queued since, so the
  // per-message cap holds across several drops before a re-render and a late
  // upload can tell whether its entry still exists.
  const stateRef = useRef<ListState>(state);

  useEffect(() => {
    sessionRef.current = sessionId;
    stateRef.current = state;
  }, [sessionId, state]);

  const update = useCallback((next: ListState): void => {
    stateRef.current = next;
    setState(next);
  }, []);

  const addFiles = useCallback(
    (files: readonly File[]): void => {
      if (files.length === 0) return;
      const targetSession = sessionRef.current;
      const prev = stateRef.current;
      const current = prev.sessionId === targetSession ? prev.list : NO_UPLOADS;
      const room = Math.max(0, CHAT_UPLOADS_PER_MESSAGE - current.filter((u) => u.status !== 'error').length);
      const added = files.map((file, index): { upload: ComposerUpload; file: File } => {
        const refusal = index >= room ? 'tooMany' : precheckUpload(file);
        return {
          file,
          upload: {
            localId: nextLocalId(),
            fileName: file.name,
            sizeBytes: file.size,
            status: refusal ? 'error' : 'uploading',
            ...(refusal ? { error: refusal } : {}),
          },
        };
      });
      update({ sessionId: targetSession, list: [...current, ...added.map((a) => a.upload)] });
      for (const { upload, file } of added) {
        if (upload.status !== 'uploading') continue;
        void uploadChatFile(targetSession, file).then((outcome) => {
          const latest = stateRef.current;
          const alive = latest.sessionId === targetSession && latest.list.some((u) => u.localId === upload.localId);
          if (!alive) {
            // Removed while uploading, or its list was replaced: do not keep it.
            if (outcome.ok) void deleteChatUpload(targetSession, outcome.file.storageKey);
            return;
          }
          const patch: Partial<ComposerUpload> = outcome.ok
            ? { status: 'ready', uploaded: outcome.file }
            : { status: 'error', error: outcome.error };
          update({
            sessionId: targetSession,
            list: latest.list.map((u) => (u.localId === upload.localId ? { ...u, ...patch } : u)),
          });
        });
      }
    },
    [update],
  );

  const remove = useCallback(
    (localId: string): void => {
      const latest = stateRef.current;
      const gone = latest.list.find((u) => u.localId === localId);
      if (gone?.uploaded) void deleteChatUpload(latest.sessionId, gone.uploaded.storageKey);
      update({ sessionId: latest.sessionId, list: latest.list.filter((u) => u.localId !== localId) });
    },
    [update],
  );

  const clear = useCallback((): void => {
    update({ sessionId: sessionRef.current, list: NO_UPLOADS });
  }, [update]);

  return {
    uploads,
    addFiles,
    remove,
    clear,
    ready: readyUploads(uploads),
    busy: uploads.some((u) => u.status === 'uploading'),
  };
}
