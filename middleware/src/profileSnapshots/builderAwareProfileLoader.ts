import { createHash } from 'node:crypto';

import type { BuildPipeline } from '../plugins/builder/buildPipeline.js';
import type { DraftStore } from '../plugins/builder/draftStore.js';
import { specToAgentMd } from '../plugins/builder/specToAgentMd.js';
import type { InstalledRegistry } from '../plugins/installedRegistry.js';
import type {
  LiveProfileState,
  LiveProfileStorageService,
} from '../profileStorage/liveProfileStorageService.js';

/**
 * Snapshot-source resolution for the SnapshotService.
 *
 * Two callers exist for `profileLoader(profileId)`:
 *
 *   1. **Builder-Draft snapshot** — `profile_id == draft_id`. The
 *      operator wants a snapshot of the agent they're authoring,
 *      NOT the entire installed-plugin set. Plugin pins are empty:
 *      a draft is a single plugin's content; pins belong to
 *      Bootstrap-Profile bundles, not author-time captures.
 *
 *   2. **Bootstrap-Profile snapshot** — `profile_id` is a
 *      well-known YAML id (`production`, `minimal-dev`, …). Pins
 *      reflect the full registry. Legacy semantics, kept for
 *      operator-side use of `/api/v1/profiles/<id>/snapshots`.
 *
 * The loader detects the kind by `draftStore.findById(profileId)`.
 * Drafts always have UUIDs that don't collide with Bootstrap-Profile
 * kebab-case ids — both lookup paths can therefore key on the same
 * id space without ambiguity.
 */
export function makeBuilderAwareProfileLoader(deps: {
  liveProfileStorage: LiveProfileStorageService;
  draftStore: DraftStore;
  installedRegistry: InstalledRegistry;
  /** Optional. When provided, the loader runs the BuildPipeline against
   *  the draft and ships the resulting installable plugin ZIP as a
   *  vendored plugin in the bundle. Without it, snapshots still capture
   *  spec.json + agent.md but lack the compiled artifact, so the
   *  download is source-only. */
  buildPipeline?: BuildPipeline;
}): (profileId: string) => Promise<LiveProfileState> {
  return async (profileId: string): Promise<LiveProfileState> => {
    const draft = await deps.draftStore.findById(profileId);
    if (draft) {
      // Builder-Draft path: snapshot only this agent, no global plugin
      // pins. The bridge mirrors `agent.md` into profile_agent_md on
      // every spec/name save — but the operator can also click
      // "Snapshot erstellen" before any save fires, so we render the
      // bytes inline here when the mirror is still empty. Either way,
      // the snapshot reflects the CURRENT spec, not "last save or
      // empty buffer".
      //
      // The full AgentSpec rides along as `knowledge/spec.json` so a
      // rollback can actually restore the plugin: agent.md alone
      // doesn't carry slot code, tools, setup-fields, or the playbook
      // structure that codegen consumes. With spec.json in the bundle
      // a downstream importer (or a re-build after rollback) has
      // everything it needs to re-derive the package; without it the
      // download is just the prose body. Knowledge's `.json` extension
      // allowlist already accepts this, no Bundle-spec change needed.
      const [agentRecord, knowledgeSummaries] = await Promise.all([
        deps.liveProfileStorage.getAgentMd(profileId),
        deps.liveProfileStorage.listKnowledge(profileId),
      ]);
      const userKnowledge = await Promise.all(
        knowledgeSummaries
          .filter((s) => s.filename !== 'spec.json')
          .map(async (s) => {
            const rec = await deps.liveProfileStorage.getKnowledgeFile(
              profileId,
              s.filename,
            );
            if (!rec) {
              throw new Error(
                `internal: knowledge row vanished between list and read for ${profileId}/${s.filename}`,
              );
            }
            return { filename: rec.filename, content: rec.content };
          }),
      );
      const inlineAgentMd =
        agentRecord?.content ??
        specToAgentMd({
          draftId: profileId,
          draftName: draft.name,
          spec: draft.spec,
        });
      const specJsonContent = Buffer.from(
        JSON.stringify(draft.spec, null, 2),
        'utf8',
      );

      // Run the BuildPipeline if available. A successful build produces
      // the installable plugin ZIP that operators can drop straight into
      // another instance's plugin-upload UI. Failures are swallowed
      // here — the snapshot still captures spec.json + agent.md, and
      // the download endpoint surfaces the build state to the user.
      let pluginPins: LiveProfileState['pluginPins'] = [];
      const inlineVendoredPlugins: NonNullable<
        LiveProfileState['inlineVendoredPlugins']
      > = new Map();
      if (deps.buildPipeline) {
        try {
          const result = await deps.buildPipeline.run({
            userEmail: draft.userEmail,
            draftId: profileId,
          });
          if (result.buildResult.ok) {
            const zipBuffer = result.buildResult.zip;
            const sha256 = createHash('sha256').update(zipBuffer).digest('hex');
            const pluginId = draft.spec.id || profileId;
            const pluginVersion =
              draft.spec.version && draft.spec.version.length > 0
                ? draft.spec.version
                : '0.1.0';
            pluginPins = [
              { id: pluginId, version: pluginVersion, sha256 },
            ];
            inlineVendoredPlugins.set(`${pluginId}@${pluginVersion}`, zipBuffer);
          } else {
            console.warn(
              `[snapshot] build failed for draft ${profileId} (reason=${result.buildResult.reason}) — snapshot will be source-only`,
            );
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(
            `[snapshot] BuildPipeline threw for draft ${profileId}: ${msg} — snapshot will be source-only`,
          );
        }
      }

      const result: LiveProfileState = {
        profileId,
        profileName: draft.name,
        profileVersion:
          draft.spec.version && draft.spec.version.length > 0
            ? draft.spec.version
            : '1.0.0',
        agentMd: inlineAgentMd,
        pluginPins,
        knowledge: [
          { filename: 'spec.json', content: specJsonContent },
          ...userKnowledge,
        ],
      };
      if (inlineVendoredPlugins.size > 0) {
        result.inlineVendoredPlugins = inlineVendoredPlugins;
      }
      return result;
    }

    // Bootstrap-Profile: legacy registry-wide pin set. Phase 2.4
    // (export/import) consumes this when an operator wants to ship
    // an entire deployment as a portable bundle.
    return deps.liveProfileStorage.getLiveProfileBundle({
      profileId,
      profileName: profileId,
      pluginRegistry: deps.installedRegistry,
    });
  };
}
