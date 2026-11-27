'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  CHAT_UPLOADS_PER_MESSAGE,
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

let localCounter = 0;
function nextLocalId(): string {
  localCounter += 1;
  return `upload-${String(Date.now())}-${String(localCounter)}`;
}

/**
 * #2336 — the composer's attachment list for the chat `sessionId`. Switching
 * chats empties it: an upload is bound to the chat it was made in (ADR-0310)
 * and could not be sent from another one.
 */
export function useComposerUploads(sessionId: string): ComposerUploads {
  // The list belongs to the chat it was filled in; another chat reads it as
  // empty, so a chat switch needs no reset effect.
  const [state, setState] = useState<{ sessionId: string; list: readonly ComposerUpload[] }>({
    sessionId,
    list: [],
  });
  const uploads = state.sessionId === sessionId ? state.list : NO_UPLOADS;
  const sessionRef = useRef(sessionId);
  // The list as last rendered plus what `addFiles` queued since, so the
  // per-message cap holds across several drops before a re-render.
  const uploadsRef = useRef<readonly ComposerUpload[]>(uploads);

  useEffect(() => {
    sessionRef.current = sessionId;
    uploadsRef.current = uploads;
  }, [sessionId, uploads]);

  const setUploads = useCallback(
    (update: (list: readonly ComposerUpload[]) => readonly ComposerUpload[]): void => {
      setState((prev) => {
        const current = sessionRef.current;
        return { sessionId: current, list: update(prev.sessionId === current ? prev.list : NO_UPLOADS) };
      });
    },
    [],
  );

  const patch = useCallback(
    (localId: string, next: Partial<ComposerUpload>): void => {
      setUploads((list) => list.map((u) => (u.localId === localId ? { ...u, ...next } : u)));
    },
    [setUploads],
  );

  const addFiles = useCallback(
    (files: readonly File[]): void => {
      if (files.length === 0) return;
      const targetSession = sessionRef.current;
      const room = Math.max(
        0,
        CHAT_UPLOADS_PER_MESSAGE - uploadsRef.current.filter((u) => u.status !== 'error').length,
      );
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
      uploadsRef.current = [...uploadsRef.current, ...added.map((a) => a.upload)];
      setUploads((list) => [...list, ...added.map((a) => a.upload)]);
      for (const { upload, file } of added) {
        if (upload.status !== 'uploading') continue;
        void uploadChatFile(targetSession, file).then((outcome) => {
          // A chat switch emptied the list; the late answer has nowhere to go.
          if (sessionRef.current !== targetSession) return;
          patch(
            upload.localId,
            outcome.ok
              ? { status: 'ready', uploaded: outcome.file }
              : { status: 'error', error: outcome.error },
          );
        });
      }
    },
    [patch, setUploads],
  );

  const remove = useCallback(
    (localId: string): void => {
      setUploads((list) => list.filter((u) => u.localId !== localId));
    },
    [setUploads],
  );

  const clear = useCallback((): void => {
    uploadsRef.current = NO_UPLOADS;
    setUploads(() => NO_UPLOADS);
  }, [setUploads]);

  return {
    uploads,
    addFiles,
    remove,
    clear,
    ready: readyUploads(uploads),
    busy: uploads.some((u) => u.status === 'uploading'),
  };
}
