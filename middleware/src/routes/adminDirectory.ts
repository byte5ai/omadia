// ADR-0300 — the operator view of the Entra-fed directory of people:
// sync state per tenant with "Sync now", the people list, and per person the
// linked channel identities and connected MCP servers (unlink / revoke).
// Mounted under `/api/v1/admin/directory` behind the session gate; every
// change is audited (ADR-0100), the audit row first.

import { Router } from 'express';
import type { Request, Response } from 'express';

import type { KnowledgeGraph } from '@omadia/plugin-api';

import { auditActorFromRequest, type AuditEntryInput } from '../auth/adminAuditLog.js';
import { ENTRA_PROVIDER_ID } from '../auth/providers/EntraProvider.js';
import type { UserStore } from '../auth/userStore.js';
import { linkedIdentitiesOf } from '../directory/directoryLinks.js';
import type { DirectoryService } from '../directory/directoryService.js';
import type { DirectoryPerson, DirectoryPersonStatus, DirectoryStore } from '../directory/directoryStore.js';
import { requireUuidParam } from '../http/uuidParam.js';

/** One MCP server a person has connected. */
export interface PersonConnection {
  readonly serverId: string;
  readonly serverName: string;
}

export interface AdminDirectoryDeps {
  readonly store: DirectoryStore;
  readonly service: DirectoryService;
  readonly audit: { record(entry: AuditEntryInput): Promise<void> };
  readonly users?: () => Pick<UserStore, 'findByProviderUserId'> | undefined;
  readonly knowledgeGraph?: () => KnowledgeGraph | undefined;
  /** The MCP servers the person key holds a token for. */
  readonly connectionsOf: (personKey: string) => Promise<readonly PersonConnection[]>;
  /** Revoke and delete one connection; `false` when there was none. */
  readonly revokeConnection: (serverId: string, personKey: string) => Promise<boolean>;
}

const LINKABLE_TYPES = new Set(['telegram', 'slack', 'discord', 'whatsapp', 'imessage']);

function toPublicPerson(person: DirectoryPerson): Record<string, unknown> {
  return {
    id: person.id,
    source: person.source,
    tenantId: person.tenantId,
    objectId: person.externalId,
    displayName: person.displayName,
    upn: person.upn,
    mail: person.mail,
    accountEnabled: person.accountEnabled,
    status: person.status,
    firstSeenAt: person.firstSeenAt.toISOString(),
    syncedAt: person.syncedAt.toISOString(),
    deprovisionedAt: person.deprovisionedAt?.toISOString() ?? null,
  };
}

function intQuery(value: unknown, fallback: number): number {
  const n = typeof value === 'string' ? Number.parseInt(value, 10) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function readStatus(value: unknown): DirectoryPersonStatus | undefined {
  return value === 'active' || value === 'deprovisioned' ? value : undefined;
}

const iso = (d: Date | null): string | null => d?.toISOString() ?? null;

export function createAdminDirectoryRouter(deps: AdminDirectoryDeps): Router {
  const router = Router();
  router.param('id', requireUuidParam('directory.not_found'));

  // ── GET /admin/directory ──────────────────────────────────────────────────
  router.get('/', async (req: Request, res: Response) => {
    const states = await deps.store.listSyncStates();
    const registered = deps.service.registeredSources();
    const keys = new Set([...registered, ...states].map((s) => `${s.source}:${s.tenantId.toLowerCase()}`));
    const sources = [...keys].sort().map((key) => {
      const live = registered.find((s) => `${s.source}:${s.tenantId.toLowerCase()}` === key);
      const state = states.find((s) => `${s.source}:${s.tenantId.toLowerCase()}` === key);
      const source = (live?.source ?? state?.source)!;
      const tenantId = (live?.tenantId ?? state?.tenantId)!;
      return {
        source,
        tenantId,
        channelId: live?.channelId ?? null,
        registered: live !== undefined,
        running: deps.service.isRunning(source, tenantId),
        lastStartedAt: iso(state?.lastStartedAt ?? null),
        lastCompletedAt: iso(state?.lastCompletedAt ?? null),
        lastFullAt: iso(state?.lastFullAt ?? null),
        lastError: state?.lastError ?? null,
      };
    });
    const search = typeof req.query['search'] === 'string' ? req.query['search'].slice(0, 200) : undefined;
    const status = readStatus(req.query['status']);
    const { people, total } = await deps.store.list({
      ...(search ? { search } : {}),
      ...(status ? { status } : {}),
      limit: intQuery(req.query['limit'], 100),
      offset: intQuery(req.query['offset'], 0),
    });
    res.json({ sources, people: people.map(toPublicPerson), total });
  });

  // ── POST /admin/directory/sync ────────────────────────────────────────────
  router.post('/sync', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { source?: unknown; tenantId?: unknown };
    const tenantId = typeof body.tenantId === 'string' ? body.tenantId.trim() : '';
    if (body.source !== 'entra' || tenantId === '') {
      res.status(400).json({ code: 'directory.invalid_source' });
      return;
    }
    if (!deps.service.registeredSources().some((s) => s.tenantId.toLowerCase() === tenantId.toLowerCase())) {
      res.status(404).json({ code: 'directory.source_not_registered' });
      return;
    }
    await deps.audit.record({
      actor: auditActorFromRequest(req),
      action: 'directory.sync',
      target: `directory:entra:${tenantId}`,
    });
    const run = deps.service.sync('entra', tenantId);
    if (!run) {
      res.status(503).json({ code: 'directory.unavailable' });
      return;
    }
    // A long full read must not hold the request; the view polls the state.
    void run;
    res.status(202).json({ started: true });
  });

  // ── GET /admin/directory/people/:id ───────────────────────────────────────
  router.get('/people/:id', async (req: Request, res: Response) => {
    const person = await deps.store.findById(String(req.params['id']));
    if (!person) {
      res.status(404).json({ code: 'directory.not_found' });
      return;
    }
    const webLogin = await deps.users?.()?.findByProviderUserId(ENTRA_PROVIDER_ID, person.externalId);
    const kg = deps.knowledgeGraph?.();
    const [identities, connections] = await Promise.all([
      kg ? linkedIdentitiesOf(kg, person) : Promise.resolve([]),
      deps.connectionsOf(person.externalId),
    ]);
    res.json({
      person: toPublicPerson(person),
      webLogin: webLogin ? { userId: webLogin.id, email: webLogin.email, status: webLogin.status } : null,
      linkedIdentities: identities.map((i) => ({ channelType: i.channelKind, channelUserId: i.channelUserId })),
      connections,
    });
  });

  // ── POST /admin/directory/people/:id/unlink ───────────────────────────────
  router.post('/people/:id/unlink', async (req: Request, res: Response) => {
    const person = await deps.store.findById(String(req.params['id']));
    const kg = deps.knowledgeGraph?.();
    if (!person) {
      res.status(404).json({ code: 'directory.not_found' });
      return;
    }
    const body = (req.body ?? {}) as { channelType?: unknown; channelUserId?: unknown };
    const channelType = typeof body.channelType === 'string' ? body.channelType : '';
    const channelUserId = typeof body.channelUserId === 'string' ? body.channelUserId : '';
    if (!LINKABLE_TYPES.has(channelType) || channelUserId === '') {
      res.status(400).json({ code: 'directory.invalid_identity' });
      return;
    }
    if (!kg?.linkChannelIdentity) {
      res.status(503).json({ code: 'directory.unavailable' });
      return;
    }
    const linked = await linkedIdentitiesOf(kg, person);
    const identity = linked.find((i) => i.channelKind === channelType && i.channelUserId === channelUserId);
    if (!identity) {
      res.status(404).json({ code: 'directory.not_linked' });
      return;
    }
    await deps.audit.record({
      actor: auditActorFromRequest(req),
      action: 'channel_identity.unlink',
      target: `channel_identity:${identity.channelKind}:${identity.channelUserId}`,
      before: { linkedDirectoryPersonId: person.id },
      after: null,
    });
    await kg.linkChannelIdentity({ ...identity, target: null });
    res.json({ ok: true });
  });

  // ── POST /admin/directory/people/:id/connections/:serverId/revoke ────────
  router.post('/people/:id/connections/:serverId/revoke', async (req: Request, res: Response) => {
    const person = await deps.store.findById(String(req.params['id']));
    if (!person) {
      res.status(404).json({ code: 'directory.not_found' });
      return;
    }
    const serverId = String(req.params['serverId'] ?? '');
    const connections = await deps.connectionsOf(person.externalId);
    if (!connections.some((c) => c.serverId === serverId)) {
      res.status(404).json({ code: 'directory.not_connected' });
      return;
    }
    await deps.audit.record({
      actor: auditActorFromRequest(req),
      action: 'directory_person.revoke_connection',
      target: `directory_person:${person.id}`,
      before: { serverId },
      after: null,
    });
    await deps.revokeConnection(serverId, person.externalId);
    res.json({ ok: true });
  });

  return router;
}
