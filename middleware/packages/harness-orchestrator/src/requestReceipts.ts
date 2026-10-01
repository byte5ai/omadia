import type { PrivacyReceipt, VerifierEgressSummary } from '@omadia/plugin-api';

/**
 * The privacy receipt of ONE user request that ran in several passes.
 *
 * A verifier re-entry (borderline resample, correction retry, stream retry)
 * is a pass of its own: it opens a privacy scope, sends the first run's tool
 * results to the model again and finalizes that scope into a receipt. Before
 * this module every pass also persisted its receipt as a row of its own, and
 * the answer the user got carried only the receipt of the pass that produced
 * it — a delivered retry hid the first run's bypassed tools, a delivered first
 * answer hid what the resample sent.
 *
 * Now the binder of a re-entry (`VerifierService`) collects every pass's
 * receipt here — behind a Privacy Shield once the pass is finalized after the
 * verifier, so the pass's receipt also accounts for the verifier's requests
 * on it (`verifierEgress`). The answer it delivers carries {@link mergePrivacyReceipts} of
 * all of them, and the request's ONE row is written once, through the first
 * pass (the only one that persisted on its own before), with that merged
 * receipt. A turn no re-entry can follow never comes here and persists exactly
 * as before.
 */

/**
 * One receipt for several passes of the same request.
 *
 * A single pass is returned as it is, so a request without a re-entry keeps
 * its receipt byte for byte. For several passes:
 *  - counts are the LARGEST pass, not the sum: a re-entry replays the same
 *    tool results, and interning them again is the same data, not more;
 *  - the verifier's requests are the exception: each pass's are requests of
 *    their own, so `verifierEgress.requests` is the SUM, its masked span
 *    types the union;
 *  - lists are the union, first occurrence first: an entry every pass
 *    recorded (a bypassed tool, a redacted tool error) is listed once;
 *  - flags are set when any pass set them.
 */
export function mergePrivacyReceipts(receipts: readonly PrivacyReceipt[]): PrivacyReceipt | undefined {
  const [first, ...rest] = receipts;
  if (first === undefined) return undefined;
  if (rest.length === 0) return first;
  const max = (pick: (r: PrivacyReceipt) => number | undefined): number =>
    Math.max(...receipts.map((r) => pick(r) ?? 0));
  const identityValuesOnWire = receipts.some((r) => r.identityValuesOnWire !== undefined)
    ? max((r) => r.identityValuesOnWire)
    : undefined;
  const bypassedTools = union(receipts.map((r) => r.bypassedTools));
  const maskedPromptSpans = union(receipts.map((r) => r.maskedPromptSpans));
  const structuredPayloads = union(receipts.map((r) => r.structuredPayloads));
  const toolErrors = union(receipts.map((r) => r.toolErrors));
  const verifierEgress = mergeVerifierEgress(receipts.map((r) => r.verifierEgress));
  return {
    datasetsInterned: max((r) => r.datasetsInterned),
    fieldsMasked: max((r) => r.fieldsMasked),
    fieldsCleartext: max((r) => r.fieldsCleartext),
    verbsExecuted: union(receipts.map((r) => r.verbsExecuted)),
    pseudonymProjectionUsed: receipts.some((r) => r.pseudonymProjectionUsed),
    ...(identityValuesOnWire !== undefined ? { identityValuesOnWire } : {}),
    ...(bypassedTools.length > 0 ? { bypassedTools } : {}),
    ...(maskedPromptSpans.length > 0 ? { maskedPromptSpans } : {}),
    ...(structuredPayloads.length > 0 ? { structuredPayloads } : {}),
    ...(toolErrors.length > 0 ? { toolErrors } : {}),
    ...(verifierEgress ? { verifierEgress } : {}),
  };
}

/** The verifier's requests over several passes: summed, span types unioned.
 *  Absent when no pass sent one. */
function mergeVerifierEgress(
  summaries: ReadonlyArray<VerifierEgressSummary | undefined>,
): VerifierEgressSummary | undefined {
  const present = summaries.filter((v): v is VerifierEgressSummary => v !== undefined);
  if (present.length === 0) return undefined;
  return {
    requests: present.reduce((sum, v) => sum + v.requests, 0),
    maskedSpans: union(present.map((v) => v.maskedSpans)),
  };
}

/** Union of several lists by structural equality, first occurrence first. */
function union<T>(lists: ReadonlyArray<readonly T[] | undefined>): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const list of lists) {
    for (const item of list ?? []) {
      const key = JSON.stringify(item);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    }
  }
  return out;
}

/** A pass offering to own the request's receipt row: the row's key (the
 *  pass's turn id) and the writer (the orchestrator's `persistTurnReceipt`
 *  bound to that turn). The writer is expected not to throw. */
export interface ReceiptRowOwner {
  readonly rowId: string;
  readonly write: (receipt: PrivacyReceipt) => Promise<void>;
}

/** The receipts of one request's passes, and its one row. */
export class RequestReceipts {
  readonly #receipts: PrivacyReceipt[] = [];
  #owner: ReceiptRowOwner | undefined;
  #committed = false;

  /**
   * Adds one pass's receipt. The first pass that offers to own the row owns
   * it — normally the first run — and later offers are declined. Returns
   * whether this pass owns the row.
   */
  add(receipt: PrivacyReceipt, owner?: ReceiptRowOwner): boolean {
    this.#receipts.push(receipt);
    if (owner === undefined || this.#owner !== undefined) return false;
    this.#owner = owner;
    return true;
  }

  /** The key the request's row is (or will be) written under, if any pass
   *  owns it. */
  get rowId(): string | undefined {
    return this.#owner?.rowId;
  }

  /** The request's receipt so far (every pass merged), or undefined. */
  merged(): PrivacyReceipt | undefined {
    return mergePrivacyReceipts(this.#receipts);
  }

  /**
   * Writes the request's row once, with the merged receipt. Later calls do
   * nothing; so does a request no pass wrote a receipt for. Never throws: the
   * answer outranks the audit row, and the writer logs its own failure.
   */
  async commit(): Promise<void> {
    if (this.#committed) return;
    this.#committed = true;
    const receipt = this.merged();
    if (receipt === undefined || this.#owner === undefined) return;
    try {
      await this.#owner.write(receipt);
    } catch (err) {
      console.error('[orchestrator] request receipt could not be written:', err);
    }
  }
}
