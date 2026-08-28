/**
 * `teamsProvisioner@1` — the kernel's SINGLE choke point for the Teams
 * provisioning capability (epic byte5ai/omadia#860, wave W1a).
 *
 * The capability itself is implemented and REGISTERED by the
 * `@omadia/integration-microsoft365` connector plugin (≥ 0.3.1); every
 * Graph/ARM call happens inside that plugin. The middleware consumes it
 * through the {@link ServiceRegistry} — this module is the only place that
 *
 *   (a) resolves `serviceRegistry.get<TeamsProvisionerAccessor>('teamsProvisioner')`
 *       (as {@link KERNEL_SERVICE_CALLER} — the kernel's own identity), and
 *   (b) builds the per-bot messaging endpoint URL
 *       (`https://<public-base-url>/api/teams/<botSlug>/messages`,
 *       the per-bot route shipped in channel-teams 0.20.0),
 *
 * so the operator router, the provisioning job runner and the status
 * projection never duplicate either.
 *
 * MIRRORED CONTRACT. The connector is not vendored in this checkout, so the
 * `TeamsProvisionerAccessor` surface and its typed error taxonomy are
 * mirrored here from the connector repo (`omadia-m365-connector`,
 * `src/teamsProvisioner/{index,types,errors,appRegistration,botService,
 * catalog,install,appPackage,secretStore}.ts`, v0.4.0). Keep in sync when
 * the connector's surface changes. Mirroring the SHIPPED accessor — NOT the
 * deprecated `TeamsProvisioner` sketch (`registerApplication`/
 * `addClientSecret`): the connector's own types.ts deprecates that sketch
 * ("coding against THIS interface compiles but fails at runtime").
 *
 * VERSION SKEW IS THE NORMAL CASE. The contract is mirrored, not imported,
 * so this middleware can be NEWER than the connector installed next to it —
 * an operator upgrades the two independently. Methods the connector gained
 * after the oldest supported version are therefore declared OPTIONAL here
 * and callers must FEATURE-DETECT instead of assuming.
 * {@link supportsTeamUninstall} is the guard for the first such method,
 * `uninstallFromTeam` (connector >= 0.4.0, byte5ai/omadia#900): against an
 * older connector the operator route keeps answering its 501 rather than
 * crashing on an undefined call.
 *
 * SECRET CUSTODY. The shipped contract never lets a cleartext client secret
 * cross the service boundary: `createAppRegistration` persists the generated
 * password into the CONNECTOR's vault and returns only the opaque
 * `secretRef` (`teams_bot_password:<appId>`). The wrapper returned by
 * {@link requireTeamsProvisioner} additionally strips any cleartext-looking
 * field (`secretText`, `clientSecret`) a mis-implemented provider might
 * attach, so no caller downstream of this choke point can log or persist
 * one. Nothing here (or in the identity table) stores a secret value.
 *
 * SINGLE-TENANT INVARIANT. New MultiTenant Entra registrations are
 * deprecated (07/2025); the contract models exactly one sign-in audience
 * (`'AzureADMyOrg'`). The wrapper enforces this at the accessor boundary:
 * inputs carrying an unknown tenant mode or a foreign `signInAudience` are
 * rejected with {@link SingleTenantViolationError} before they reach the
 * connector.
 *
 * Typed errors thrown by the CONNECTOR cross the plugin boundary as plain
 * `Error` instances whose class identity is the plugin's, not ours — so
 * consumers must never `instanceof` against local mirrors. Use the
 * duck-typed guards ({@link isConsentMissingError}, …), which match on
 * `error.name` plus the structured fields.
 */

import { KERNEL_SERVICE_CALLER, type ServiceRegistry } from './serviceRegistry.js';
import type { TeamsDelegatedProvisionerMethods } from './teamsDelegatedSignIn.js';

/** Service-registry key (bare, unversioned). */
export const TEAMS_PROVISIONER_SERVICE_NAME = 'teamsProvisioner';
/** Manifest capability ref (`provides:` / `requires:` form). */
export const TEAMS_PROVISIONER_CAPABILITY = 'teamsProvisioner@1';

// ---------------------------------------------------------------------------
// Mirrored contract types (connector v0.3.1) — see module doc.
// ---------------------------------------------------------------------------

/** Which tenant the provisioner operates against. MultiTenant is NOT a mode. */
export type TenantMode = 'customer' | 'home';

/** The only sign-in audience the provisioner will ever create. */
export type SignInAudience = 'AzureADMyOrg';

/** Idempotency signal for steps whose remote API answers 409 on re-runs. */
export type IdempotentOutcome = 'created' | 'already-existed';

/** Result wrapper carrying the {@link IdempotentOutcome} alongside the value. */
export interface Idempotent<T> {
  readonly outcome: IdempotentOutcome;
  readonly value: T;
}

/** A provisioned (or found) Entra app registration. */
export interface AppRegistration {
  /** Application (client) id — what Bot Framework calls the MSA app id. */
  readonly appId: string;
  /** Directory object id of the `application` resource. */
  readonly objectId: string;
  readonly tenantId: string;
  readonly tenantMode: TenantMode;
  readonly signInAudience: SignInAudience;
  readonly displayName: string;
  /** Stable idempotency key the registration was created/found under, if any. */
  readonly uniqueName?: string;
}

/** Opaque vault reference to a bot password — NEVER the cleartext value. */
export type TeamsBotPasswordSecretRef = `teams_bot_password:${string}`;

export interface CreateAppRegistrationInput {
  readonly displayName: string;
  /** Label only — the audience is ALWAYS SingleTenant (`'AzureADMyOrg'`). */
  readonly tenantMode: TenantMode;
  /** Stable idempotency key (Graph `uniqueName`). */
  readonly uniqueName?: string;
  /** Portal label for the generated secret. */
  readonly secretDisplayName?: string;
  /**
   * Called the moment the registration exists — after Graph confirms the
   * create (or the adoption), BEFORE the client secret and the service
   * principal. This is where a caller persists `app_id`, so an interruption
   * anywhere in the rest of the chain leaves a RESUMABLE row instead of an
   * app registration nobody knows about (byte5ai/omadia#916).
   *
   * Connector >= 0.5.0. An older connector silently ignores the property and
   * the caller simply learns the app id at the end, as before — no feature
   * detection needed, but also no early persistence.
   */
  readonly onRegistrationCreated?: (
    registration: AppRegistration,
    outcome: IdempotentOutcome,
  ) => void | Promise<void>;
}

/** What `createAppRegistration` hands back — NO secret value, only the ref. */
export interface ProvisionedAppRegistration {
  readonly appId: string;
  /** Opaque vault reference to the generated password (connector custody). */
  readonly secretRef: TeamsBotPasswordSecretRef;
  readonly registration: AppRegistration;
  /** `keyId` of the added password credential. */
  readonly secretKeyId: string;
  /** ISO-8601 expiry of the added password credential. */
  readonly secretEndDateTime: string;
  readonly servicePrincipalOutcome: IdempotentOutcome;
}

export type DeleteAppRegistrationOutcome = 'deleted' | 'already-deleted';

export interface DeleteAppRegistrationInput {
  readonly appId: string;
  /** When provided, the stored bot password is removed from the vault too. */
  readonly secretRef?: string;
}

export interface DeleteAppRegistrationResult {
  readonly outcome: DeleteAppRegistrationOutcome;
}

/** An Azure Bot resource created via ARM REST. */
export interface AzureBot {
  readonly botName: string;
  readonly resourceId: string;
  readonly msaAppId: string;
  readonly messagingEndpoint: string;
}

/** Typed degraded outcome: Graph-only config, no ARM — no bot creation. */
export interface RegistrationOnlyOutcome {
  readonly kind: 'registration-only';
  readonly reason: 'arm-not-configured';
  readonly missingSetupFields: readonly string[];
}

export interface BotProvisionedOutcome {
  readonly kind: 'provisioned';
  readonly bot: Idempotent<AzureBot>;
}

export type BotProvisioningOutcome = BotProvisionedOutcome | RegistrationOnlyOutcome;

export interface CreateBotInput {
  /** ARM resource name / bot handle (also the idempotency key). */
  readonly botName: string;
  readonly displayName: string;
  readonly msaAppId: string;
  readonly msaAppTenantId: string;
  readonly messagingEndpoint: string;
}

export type DeleteBotOutcome = 'deleted' | 'already-deleted';

export interface BotDeletedResult {
  readonly kind: 'deleted';
  readonly outcome: DeleteBotOutcome;
}

export type DeleteBotResult = BotDeletedResult | RegistrationOnlyOutcome;

export interface BotFoundResult {
  readonly kind: 'found';
  readonly bot: AzureBot;
}

export interface BotNotFoundResult {
  readonly kind: 'not-found';
}

export type GetBotResult = BotFoundResult | BotNotFoundResult | RegistrationOnlyOutcome;

/** Per-agent icon PNGs for the Teams app package. */
export interface AppPackageIcons {
  /** PNG bytes for `color.png` (192×192). */
  readonly color: Uint8Array;
  /** PNG bytes for `outline.png` (32×32, transparent). */
  readonly outline: Uint8Array;
}

export type AppPackageParamValue = string | readonly string[];
export type AppPackageParams = Readonly<Record<string, AppPackageParamValue>>;

export interface BuildAppPackageInput {
  /** The `manifest.json.template` text from `omadia-channel-teams`. */
  readonly manifestTemplate: string;
  readonly params: AppPackageParams;
  readonly icons: AppPackageIcons;
}

/** A Teams app in the tenant app catalog. */
export interface CatalogTeamsApp {
  /** Catalog id (`teamsApp.id`) — what installs reference. */
  readonly teamsAppId: string;
  /** Manifest id (`externalId`) — the idempotency key for uploads. */
  readonly externalId: string;
  readonly displayName: string;
  readonly version: string;
}

export interface UploadToCatalogInput {
  readonly packageZip: Uint8Array;
  readonly externalId: string;
}

export interface GetCatalogAppInput {
  readonly teamsAppExternalId: string;
}

export interface CatalogAppNotFound {
  readonly found: false;
}

export interface CatalogAppFound {
  readonly found: true;
  readonly teamsAppId: string;
  readonly displayName?: string;
  readonly publishedVersion?: string;
}

export type GetCatalogAppResult = CatalogAppNotFound | CatalogAppFound;

export type ResourceSpecificPermissionType = 'application' | 'delegated';

export interface ResourceSpecificPermission {
  readonly permissionValue: string;
  readonly permissionType: ResourceSpecificPermissionType;
}

export interface ConsentedPermissionSet {
  readonly resourceSpecificPermissions: readonly ResourceSpecificPermission[];
}

export interface InstallToTeamRequest {
  readonly teamId: string;
  /** Catalog id (`CatalogTeamsApp.teamsAppId`). */
  readonly teamsAppId: string;
  /** Sent to Graph verbatim when present. */
  readonly consentedPermissionSet?: ConsentedPermissionSet;
}

export interface TeamAppInstallation {
  readonly teamId: string;
  readonly teamsAppId: string;
  readonly installationId?: string;
}

/** Input for the uninstall step — the same key `installToTeam` is idempotent on. */
export interface UninstallFromTeamInput {
  readonly teamId: string;
  /** Catalog id (`CatalogTeamsApp.teamsAppId`) — NOT the installation id. */
  readonly teamsAppId: string;
}

/**
 * Idempotency signal of the uninstall direction (connector >= 0.4.0):
 * `'uninstalled'` when the call removed the installation, `'already-absent'`
 * when the app was not installed in the team. BOTH are success — the
 * connector never throws for "not installed".
 */
export type UninstallFromTeamOutcome = 'uninstalled' | 'already-absent';

export interface UninstallFromTeamResult {
  readonly outcome: UninstallFromTeamOutcome;
  readonly value: TeamAppInstallation;
}

/**
 * The service object the connector publishes under the registry key
 * `'teamsProvisioner'` — one method per chain step; the caller (the agent
 * factory's job runner) owns ordering, persistence and retries.
 *
 * SURFACE GAP (verified against connector v0.4.0, W2a of epic #860). Team
 * installs are no longer one-way — `uninstallFromTeam` is the counterpart of
 * `installToTeam` since connector 0.4.0 (byte5ai/omadia#900) — but there is
 * still no way to LIST the teams an app is installed in (`getCatalogApp`
 * answers tenant-catalog presence, never a team install). The operator's
 * team<->agent read model therefore RECORDS every install it performs
 * (`agent_teams_installs`, migration 0051) and keeps marking live
 * enumeration as unsupported (`routes/operatorAgents.ts` ->
 * `teamsAssignmentCapabilities`): the list is what omadia did, not what
 * Graph currently holds. Widening this mirrored contract is a connector
 * change, not a middleware one: add the methods there first, then mirror
 * them here — which is exactly how `getTeam` (>= 0.5.0) arrived, and it
 * resolves a NAME for a known id rather than enumerating anything.
 *
 * `uninstallFromTeam` is OPTIONAL on this interface on purpose — see the
 * module doc's version-skew note. Never call it without
 * {@link supportsTeamUninstall}.
 */
export interface TeamsProvisionerAccessor
  extends Partial<TeamsDelegatedProvisionerMethods> {
  readonly tenantMode: TenantMode;
  /** `true` when the ARM setup fields are configured (bot creation possible). */
  readonly canCreateBots: boolean;

  createAppRegistration(
    input: CreateAppRegistrationInput,
  ): Promise<Idempotent<ProvisionedAppRegistration>>;
  deleteAppRegistration(
    input: DeleteAppRegistrationInput,
  ): Promise<DeleteAppRegistrationResult>;
  getAppRegistration(
    appId: string,
    tenantMode: TenantMode,
  ): Promise<AppRegistration | undefined>;

  /** Pure, no network — renders the per-agent Teams app package zip. */
  buildAppPackage(input: BuildAppPackageInput): Uint8Array;

  createBot(input: CreateBotInput): Promise<BotProvisioningOutcome>;
  deleteBot(botName: string): Promise<DeleteBotResult>;
  getBot(botName: string): Promise<GetBotResult>;

  uploadToCatalog(input: UploadToCatalogInput): Promise<Idempotent<CatalogTeamsApp>>;
  getCatalogApp(input: GetCatalogAppInput): Promise<GetCatalogAppResult>;

  installToTeam(input: InstallToTeamRequest): Promise<Idempotent<TeamAppInstallation>>;

  /**
   * Connector >= 0.4.0 only — ABSENT on older installs. Guard every call
   * with {@link supportsTeamUninstall}.
   */
  uninstallFromTeam?(input: UninstallFromTeamInput): Promise<UninstallFromTeamResult>;

  /**
   * Connector >= 0.5.0 only — ABSENT on older installs. Guard every call
   * with {@link supportsTeamLookup}.
   *
   * Resolves ONE team id to its Graph display name. Read-only and additive:
   * every screen that shows a team keeps working without it, showing the id
   * alone.
   */
  getTeam?(input: GetTeamInput): Promise<GetTeamResult>;

  /**
   * THE DELEGATED HALF — connector >= 0.6.0 only (byte5ai/omadia#924). All six
   * are optional together, for the same version-skew reason as the two methods
   * above, and the ONE guard for all of them is
   * `supportsDelegatedCatalogUpload` (`platform/teamsDelegatedSignIn.ts`).
   *
   * They exist because `POST /appCatalogs/teamsApps` is delegated-only at
   * Microsoft — Application permissions are documented as "Not supported", so
   * no amount of admin consent makes the app-only {@link uploadToCatalog}
   * work. An admin signs in once per TENANT; every agent provisioned after
   * that rides on the stored token set.
   *
   * `getDelegatedSignInStatus` and `revokeDelegatedSignIn` are SYNCHRONOUS by
   * contract — do not await them into a promise-typed seam.
   */
}

/** Input of the optional {@link TeamsProvisionerAccessor.getTeam}. */
export interface GetTeamInput {
  /** Teams team (group) id — the AAD group object id. */
  readonly teamId: string;
}

/**
 * Result of {@link TeamsProvisionerAccessor.getTeam}.
 *
 * `found: false` is the ordinary answer for a team that was deleted or that
 * the tenant app cannot see — NOT an error. The caller then keeps whatever
 * name it had cached rather than blanking a label over a transient lookup.
 */
export type GetTeamResult =
  | { readonly found: true; readonly teamId: string; readonly displayName: string }
  | { readonly found: false };

/**
 * Does the CURRENTLY INSTALLED connector publish the team lookup
 * (connector >= 0.5.0)? Same shape and same reason as
 * {@link supportsTeamUninstall}: the contract is mirrored, not imported, so
 * a middleware newer than its connector must ASK before it calls.
 */
export function supportsTeamLookup(
  provisioner: TeamsProvisionerAccessor | undefined,
): boolean {
  return typeof provisioner?.getTeam === 'function';
}

/**
 * Does the CURRENTLY INSTALLED connector publish the team-uninstall
 * operation (connector >= 0.4.0)? The one feature-detection predicate for
 * `uninstallFromTeam`; routers and jobs must consult it instead of calling
 * an optional method and hoping.
 *
 * Deliberately tolerant of `undefined` so a caller can chain it straight
 * onto {@link getTeamsProvisioner} without a second null check: no
 * connector at all is also no uninstall.
 */
/**
 * The delegated surface is re-exported from this choke point so every consumer
 * has ONE import site for `teamsProvisioner@1`, exactly as they do for the
 * app-only half. The definitions live in `teamsDelegatedSignIn.ts` because
 * they are a coherent feature of their own (a device-code flow, a token set,
 * four errors) and putting them here would have pushed this module past the
 * size where anyone reads it.
 */
export {
  adminConsentUrlOf,
  delegatedStepOf,
  isDelegatedConsentRequiredError,
  isDelegatedSignInRequiredError,
  isDelegatedTokenExpiredError,
  isDeviceCodeFlowError,
  isRecoverableByRefresh,
  redactDelegated,
  requiredScopesOf,
  summarizeTokenSet,
  supportsDelegatedCatalogUpload,
  type DelegatedTokenSet,
  type DeviceCodePollResult,
  type DeviceCodeStart,
  type TeamsDelegatedProvisionerMethods,
} from './teamsDelegatedSignIn.js';

export function supportsTeamUninstall(
  provisioner: TeamsProvisionerAccessor | undefined,
): boolean {
  return typeof provisioner?.uninstallFromTeam === 'function';
}

// ---------------------------------------------------------------------------
// Connector error taxonomy — duck-typed guards (see module doc on why not
// `instanceof`). Names/fields mirror `errors.ts` of the connector.
// ---------------------------------------------------------------------------

export interface ConsentMissingErrorLike extends Error {
  readonly name: 'ConsentMissingError';
  readonly missingScopes: readonly string[];
  readonly resource: 'graph' | 'arm';
}

export interface ProvisioningThrottledErrorLike extends Error {
  readonly name: 'ProvisioningThrottledError';
  readonly resource: 'graph' | 'arm';
  /** Seconds from the final `Retry-After` header, if the API provided it. */
  readonly retryAfterSeconds?: number;
}

export interface ArmNotConfiguredErrorLike extends Error {
  readonly name: 'ArmNotConfiguredError';
  readonly missingSetupFields: readonly string[];
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

/** Graph/ARM answered 403 — an application permission / admin consent is missing. */
export function isConsentMissingError(err: unknown): err is ConsentMissingErrorLike {
  return (
    err instanceof Error &&
    err.name === 'ConsentMissingError' &&
    isStringArray((err as Partial<ConsentMissingErrorLike>).missingScopes)
  );
}

/** The connector exhausted its 429 backoff budget — honor `retryAfterSeconds`. */
export function isProvisioningThrottledError(
  err: unknown,
): err is ProvisioningThrottledErrorLike {
  if (!(err instanceof Error) || err.name !== 'ProvisioningThrottledError') return false;
  const retryAfter = (err as Partial<ProvisioningThrottledErrorLike>).retryAfterSeconds;
  return retryAfter === undefined || typeof retryAfter === 'number';
}

/** An ARM-dependent step ran although the ARM setup fields are not configured. */
export function isArmNotConfiguredError(err: unknown): err is ArmNotConfiguredErrorLike {
  return (
    err instanceof Error &&
    err.name === 'ArmNotConfiguredError' &&
    isStringArray((err as Partial<ArmNotConfiguredErrorLike>).missingSetupFields)
  );
}

/** Every `error.name` in the connector's `TeamsProvisionerError` taxonomy. */
const TEAMS_PROVISIONER_ERROR_NAMES: ReadonlySet<string> = new Set([
  'ConsentMissingError',
  'ProvisioningThrottledError',
  'ArmNotConfiguredError',
  'CapabilityUnavailableError',
  'AppPackageError',
]);

/** Does this error belong to the connector's typed taxonomy at all? */
export function isTeamsProvisionerError(err: unknown): err is Error {
  return err instanceof Error && TEAMS_PROVISIONER_ERROR_NAMES.has(err.name);
}

// ---------------------------------------------------------------------------
// Kernel-side typed errors
// ---------------------------------------------------------------------------

/**
 * The `teamsProvisioner` service is not registered — the
 * `@omadia/integration-microsoft365` connector plugin (≥ 0.3.1) is not
 * installed or not active. Routers map this to 503 (mirroring the
 * `orchestratorRegistry@1` unavailable shape), the job runner to a retryable
 * failure. Never a crash.
 */
export class TeamsProvisionerUnavailableError extends Error {
  public readonly code = 'teams_provisioner_unavailable';

  constructor() {
    super(
      `${TEAMS_PROVISIONER_CAPABILITY} is not published — install and activate the @omadia/integration-microsoft365 connector plugin (>= 0.3.1).`,
    );
    this.name = 'TeamsProvisionerUnavailableError';
  }
}

/**
 * A caller tried to hand the provisioner a MultiTenant-shaped input. The
 * contract is SingleTenant-only (`signInAudience: 'AzureADMyOrg'`); this is
 * rejected at the accessor boundary, before the connector sees it.
 */
export class SingleTenantViolationError extends Error {
  public readonly code = 'single_tenant_only';
  /** Which input field carried the rejected value. */
  public readonly field: string;

  constructor(field: string, rejectedValue: unknown) {
    super(
      `single_tenant_only: '${field}' = ${JSON.stringify(rejectedValue)} — the Teams provisioner registers SingleTenant ('AzureADMyOrg') apps in tenant mode 'customer' | 'home' only`,
    );
    this.name = 'SingleTenantViolationError';
    this.field = field;
  }
}

/** The messaging-endpoint builder rejected its inputs (see {@link buildTeamsBotMessagingEndpoint}). */
export class TeamsMessagingEndpointError extends Error {
  public readonly code = 'invalid_teams_messaging_endpoint';

  constructor(problem: string, options?: ErrorOptions) {
    super(`invalid_teams_messaging_endpoint: ${problem}`, options);
    this.name = 'TeamsMessagingEndpointError';
  }
}

// ---------------------------------------------------------------------------
// Resolution — the single `serviceRegistry.get` call site
// ---------------------------------------------------------------------------

/** The one registry facet this module needs — full registry or test double. */
export type TeamsProvisionerResolver = Pick<ServiceRegistry, 'get'>;

const TENANT_MODES: ReadonlySet<string> = new Set(['customer', 'home']);

function assertTenantMode(value: unknown): asserts value is TenantMode {
  if (typeof value !== 'string' || !TENANT_MODES.has(value)) {
    throw new SingleTenantViolationError('tenantMode', value);
  }
}

function assertSingleTenantInput(input: CreateAppRegistrationInput): void {
  assertTenantMode(input.tenantMode);
  // The typed input cannot express an audience, but router bodies are runtime
  // values — a smuggled `signInAudience` other than the single-tenant one is
  // exactly what this boundary exists to stop.
  const audience = (input as unknown as Record<string, unknown>)['signInAudience'];
  if (audience !== undefined && audience !== 'AzureADMyOrg') {
    throw new SingleTenantViolationError('signInAudience', audience);
  }
}

/**
 * Strip cleartext-looking secret fields from a provider result. The shipped
 * contract never returns one, but this choke point is where the "no secret
 * crosses the boundary" invariant is ENFORCED, not assumed.
 */
function stripCleartextSecrets<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  if (!('secretText' in record) && !('clientSecret' in record)) return value;
  const { secretText: _secretText, clientSecret: _clientSecret, ...rest } = record;
  return rest as T;
}

/** Wrap the raw provider with the boundary guards this module owes callers. */
function guardAccessor(raw: TeamsProvisionerAccessor): TeamsProvisionerAccessor {
  return {
    get tenantMode() {
      return raw.tenantMode;
    },
    get canCreateBots() {
      return raw.canCreateBots;
    },
    async createAppRegistration(input) {
      assertSingleTenantInput(input);
      const result = await raw.createAppRegistration(input);
      return { ...result, value: stripCleartextSecrets(result.value) };
    },
    deleteAppRegistration: (input) => raw.deleteAppRegistration(input),
    // Async so a boundary violation REJECTS like every other failure of this
    // method, instead of throwing synchronously out of the call expression.
    getAppRegistration: async (appId, tenantMode) => {
      assertTenantMode(tenantMode);
      return raw.getAppRegistration(appId, tenantMode);
    },
    buildAppPackage: (input) => raw.buildAppPackage(input),
    createBot: (input) => raw.createBot(input),
    deleteBot: (botName) => raw.deleteBot(botName),
    getBot: (botName) => raw.getBot(botName),
    uploadToCatalog: (input) => raw.uploadToCatalog(input),
    getCatalogApp: (input) => raw.getCatalogApp(input),
    installToTeam: (input) => raw.installToTeam(input),
    // Forwarded ONLY when the raw provider has it, so the wrapper's own
    // shape answers `supportsTeamUninstall` truthfully. A `uninstallFromTeam:
    // (input) => raw.uninstallFromTeam?.(input)` here would make every
    // connector look capable and turn an old one's 501 into a silent
    // `undefined` at the call site.
    ...(typeof raw.uninstallFromTeam === 'function'
      ? {
          uninstallFromTeam: (input: UninstallFromTeamInput) =>
            (raw.uninstallFromTeam as NonNullable<
              TeamsProvisionerAccessor['uninstallFromTeam']
            >).call(raw, input),
        }
      : {}),
    // Same conditional-spread contract as `uninstallFromTeam` above, for the
    // same reason: `supportsTeamLookup` must read the WRAPPER and still get
    // the truth about the connector behind it.
    ...(typeof raw.getTeam === 'function'
      ? {
          getTeam: (input: GetTeamInput) =>
            (raw.getTeam as NonNullable<TeamsProvisionerAccessor['getTeam']>).call(
              raw,
              input,
            ),
        }
      : {}),
    // The delegated half (#924), forwarded under the SAME conditional-spread
    // contract as the two methods above and for the same hard-won reason: a
    // `uploadToCatalogDelegated: (i) => raw.uploadToCatalogDelegated?.(i)`
    // here would make every connector look capable, and turn an old one's
    // honest absence into a silent `undefined` at the call site.
    //
    // Forwarded one by one rather than as a group, even though
    // `supportsDelegatedCatalogUpload` requires all six: this wrapper's job is
    // to report the raw provider's shape truthfully, and a half-shipped
    // connector must read as half-shipped rather than as absent.
    ...forwardDelegated(raw),
  };
}

/**
 * Conditional forwarding of the six delegated methods.
 *
 * Its own function purely to keep {@link guardAccessor} readable; the rule it
 * implements is identical — a method appears on the wrapper if and only if the
 * raw provider actually has it, so `supportsDelegatedCatalogUpload` can read
 * the WRAPPER and still get the truth about the connector behind it.
 *
 * NO SECRET STRIPPING HERE, deliberately. `stripCleartextSecrets` exists
 * because the app-only contract must never hand a cleartext client secret
 * across the boundary. The delegated contract is the opposite case: the token
 * set IS the payload, the middleware is its custodian
 * (`platform/teamsDelegatedTokenStore.ts`), and stripping it would break the
 * feature. The guarantee that it never LEAKS lives at the log/response
 * boundaries instead — `redactDelegated` in `teamsDelegatedSignIn.ts`.
 */
function forwardDelegated(
  raw: TeamsProvisionerAccessor,
): Partial<TeamsDelegatedProvisionerMethods> {
  const out: Record<string, unknown> = {};
  for (const name of DELEGATED_METHOD_NAMES) {
    const method = raw[name];
    if (typeof method !== 'function') continue;
    out[name] = (...args: unknown[]) =>
      (method as (...a: unknown[]) => unknown).apply(raw, args);
  }
  return out as Partial<TeamsDelegatedProvisionerMethods>;
}

/** The six method names of the delegated half, as data — so the forwarder
 *  above cannot silently drift from the interface. */
const DELEGATED_METHOD_NAMES = [
  'uploadToCatalogDelegated',
  'startDelegatedSignIn',
  'pollDelegatedSignIn',
  'getDelegatedSignInStatus',
  'refreshDelegatedToken',
  'revokeDelegatedSignIn',
] as const satisfies readonly (keyof TeamsDelegatedProvisionerMethods)[];

/**
 * Resolve the provisioner, or `undefined` when the connector plugin is not
 * installed/active. Synchronous — resolution never awaits. Attributed to
 * {@link KERNEL_SERVICE_CALLER}: the kernel resolves for itself, never on
 * behalf of a fabricated plugin identity.
 */
export function getTeamsProvisioner(
  services: TeamsProvisionerResolver,
): TeamsProvisionerAccessor | undefined {
  const raw = services.get<TeamsProvisionerAccessor>(
    TEAMS_PROVISIONER_SERVICE_NAME,
    KERNEL_SERVICE_CALLER,
  );
  return raw === undefined ? undefined : guardAccessor(raw);
}

/**
 * Resolve the provisioner or throw the typed
 * {@link TeamsProvisionerUnavailableError} — the failure routers turn into
 * a 503 and the job runner into a non-crashing, retryable job failure.
 */
export function requireTeamsProvisioner(
  services: TeamsProvisionerResolver,
): TeamsProvisionerAccessor {
  const provisioner = getTeamsProvisioner(services);
  if (provisioner === undefined) throw new TeamsProvisionerUnavailableError();
  return provisioner;
}

// ---------------------------------------------------------------------------
// Per-bot messaging endpoint URL builder
// ---------------------------------------------------------------------------

/**
 * Bot slugs land verbatim in the Azure bot's messaging endpoint and in
 * channel-teams' per-bot route (`/api/teams/:botSlug/messages`, 0.20.0), so
 * the charset is deliberately conservative: URL-safe, no separators that
 * could re-shape the path.
 */
const BOT_SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * Build the messaging endpoint handed to Azure for one bot:
 * `https://<public-base-url>/api/teams/<botSlug>/messages`.
 *
 * The base URL is injected by the caller (the wiring unit binds it to
 * config — `TEAMS_PUBLIC_BASE_URL ?? PUBLIC_BASE_URL`); this builder owns
 * the invariants: https only (Azure requires a public TLS endpoint), no
 * credentials/query/fragment in the base, trailing slashes normalised, and
 * a path-safe slug.
 */
export function buildTeamsBotMessagingEndpoint(
  publicBaseUrl: string,
  botSlug: string,
): string {
  if (!BOT_SLUG_RE.test(botSlug)) {
    throw new TeamsMessagingEndpointError(
      `bot slug ${JSON.stringify(botSlug)} must match ${String(BOT_SLUG_RE)}`,
    );
  }
  let base: URL;
  try {
    base = new URL(publicBaseUrl);
  } catch (err) {
    throw new TeamsMessagingEndpointError(
      `public base URL ${JSON.stringify(publicBaseUrl)} is not a valid URL`,
      { cause: err },
    );
  }
  if (base.protocol !== 'https:') {
    throw new TeamsMessagingEndpointError(
      `public base URL must be https (Azure rejects non-TLS bot endpoints), got ${JSON.stringify(base.protocol)}`,
    );
  }
  if (base.username !== '' || base.password !== '') {
    throw new TeamsMessagingEndpointError('public base URL must not carry credentials');
  }
  if (base.search !== '' || base.hash !== '') {
    throw new TeamsMessagingEndpointError(
      'public base URL must not carry a query string or fragment',
    );
  }
  const basePath = base.pathname.replace(/\/+$/, '');
  return `${base.origin}${basePath}/api/teams/${encodeURIComponent(botSlug)}/messages`;
}
