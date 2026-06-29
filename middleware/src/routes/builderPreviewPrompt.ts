import type { Router, Request, Response } from 'express';

import type { DraftStore } from '../plugins/builder/draftStore.js';
import {
  compileBoundariesSection,
} from '../plugins/builder/boundaryPresets.js';
import { composePersonaSection } from '../plugins/personaCompose.js';
import {
  inferFamilyFromModel,
} from '../plugins/dynamicAgentRuntime.js';
import { resolveModelRef } from '@omadia/llm-provider';
import { compileSycophancyGuard } from '../plugins/sycophancyGuard.js';

/**
 * Issue #55 — preview-prompt route.
 *
 *   POST /v1/builder/drafts/:id/preview-prompt
 *
 * Composes the system prompt **directly from the draft spec** (not from
 * AGENT.md files or preview-build artifacts) so the operator can see
 * the live compiled prompt as soon as the spec mutates. Matches the
 * runtime compose order from `dynamicAgentRuntime`:
 *
 *   [header, persona, boundaries, sycophancy, skill]
 *
 * Returns `{ systemPrompt, tokens, sections[] }`. Token count uses a
 * deterministic `chars / 4` approximator; an Anthropic-roundtrip
 * counter remains out of scope (separate feature flag if/when needed).
 */

export interface BuilderPreviewPromptDeps {
  draftStore: DraftStore;
}

interface PreviewSection {
  label: string;
  content: string;
  kind: 'header' | 'persona' | 'boundaries' | 'sycophancy' | 'skill' | 'custom_notes';
}

const APPROX_CHARS_PER_TOKEN = 4;

export function registerBuilderPreviewPromptRoute(
  router: Router,
  deps: BuilderPreviewPromptDeps,
): void {
  router.post('/drafts/:id/preview-prompt', async (req: Request, res: Response) => {
    const email = readEmail(req);
    if (!email) {
      return sendJson(res, 401, { code: 'auth.missing', message: 'no session' });
    }
    const draftId = readId(req);
    if (!draftId) {
      return sendJson(res, 400, { code: 'builder.invalid_id', message: 'missing :id' });
    }
    const draft = await deps.draftStore.load(email, draftId);
    if (!draft) {
      return sendJson(res, 404, {
        code: 'builder.draft_not_found',
        message: `kein Draft mit id '${draftId}'`,
      });
    }

    const previewVendorId =
      resolveModelRef(draft.previewModel)?.modelId ?? draft.previewModel;
    const family = inferFamilyFromModel(previewVendorId);
    const sections: PreviewSection[] = [];

    // Header — minimal placeholder; runtime builds a richer header from
    // the install-catalog entry, but the preview only has the draft.
    const headerText = `# ${draft.spec.id || draft.name}`;
    sections.push({ label: 'Header', content: headerText, kind: 'header' });

    // Persona section
    if (draft.spec.persona) {
      const personaText = composePersonaSection({
        persona: draft.spec.persona,
        family,
      });
      if (personaText.length > 0) {
        sections.push({ label: 'Persona', content: personaText, kind: 'persona' });
      }
      if (
        typeof draft.spec.persona.custom_notes === 'string' &&
        draft.spec.persona.custom_notes.length > 0
      ) {
        sections.push({
          label: 'Custom Notes',
          content: draft.spec.persona.custom_notes,
          kind: 'custom_notes',
        });
      }
    }

    // Boundaries section
    const boundaries = draft.spec.quality?.boundaries;
    if (boundaries) {
      const { text } = compileBoundariesSection(
        boundaries.presets ?? [],
        boundaries.custom ?? [],
      );
      if (text.length > 0) {
        sections.push({ label: 'Boundaries', content: text, kind: 'boundaries' });
      }
    }

    // Sycophancy section
    const sycophancy = draft.spec.quality?.sycophancy;
    const sycophancyText = compileSycophancyGuard(sycophancy);
    if (sycophancyText.length > 0) {
      sections.push({
        label: 'Sycophancy Guard',
        content: sycophancyText,
        kind: 'sycophancy',
      });
    }

    // Skill block — render the description + role/tonality, mirroring
    // what the codegen path emits.
    if (draft.spec.description || draft.spec.skill) {
      const skillParts: string[] = [];
      if (typeof draft.spec.description === 'string' && draft.spec.description.length > 0) {
        skillParts.push(`## Mission\n${draft.spec.description}`);
      }
      const skill = draft.spec.skill;
      if (skill?.role || skill?.tonality) {
        const lines: string[] = [];
        if (skill?.role) lines.push(`- Rolle: ${skill.role}`);
        if (skill?.tonality) lines.push(`- Tonalität: ${skill.tonality}`);
        skillParts.push(`## Skill\n${lines.join('\n')}`);
      }
      if (skillParts.length > 0) {
        sections.push({
          label: 'Skill',
          content: skillParts.join('\n\n'),
          kind: 'skill',
        });
      }
    }

    const systemPrompt = sections.map((s) => s.content).join('\n\n---\n\n');
    const tokens = Math.ceil(systemPrompt.length / APPROX_CHARS_PER_TOKEN);

    res.json({ systemPrompt, tokens, sections });
  });
}

function readEmail(req: Request): string | null {
  const email = req.session?.email;
  return typeof email === 'string' && email.length > 0 ? email : null;
}

function readId(req: Request): string | null {
  const raw = req.params['id'];
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

function sendJson(
  res: Response,
  status: number,
  body: Record<string, unknown>,
): void {
  res.status(status).json(body);
}
