import { ApiError, publishConductorWorkflow } from '@/app/_lib/api';

/** Both designer surfaces try a create-only publish before offering a version update. */
export async function publishConductorDraft(
  workflow: Parameters<typeof publishConductorWorkflow>[0],
  confirmVersion: () => boolean,
): Promise<Awaited<ReturnType<typeof publishConductorWorkflow>> | null> {
  try {
    return await publishConductorWorkflow({ ...workflow, expectNew: true });
  } catch (error) {
    if (!(error instanceof ApiError) || error.code !== 'conductor.slug_exists') throw error;
    if (!confirmVersion()) return null;
    return publishConductorWorkflow(workflow);
  }
}
