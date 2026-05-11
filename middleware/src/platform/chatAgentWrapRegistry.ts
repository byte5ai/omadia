/**
 * Registry for ChatAgent wrappers — the extension-point the Answer-Verifier
 * and future "intercept-the-turn" extensions plug into.
 *
 * A wrapper is a decorator: `(inner: ChatAgent) => ChatAgent`. The kernel
 * composes registered wrappers in registration order at orchestrator boot,
 * so the outermost wrapper is the last one registered and the innermost
 * call target is the base Orchestrator.
 *
 * Today the Verifier is wired up by hand in `index.ts` — `new VerifierService({
 * orchestrator: baseOrchestrator, ... })` then the Teams bot + HTTP router
 * accept the wrapped instance. Phase 5 migrates that to `ctx.agents.wrap(...)`
 * so the Verifier becomes an extension package registering into this registry
 * rather than being hardcoded in the kernel wiring.
 *
 * For Phase 0c: the registry exists but nothing registers yet. The VerifierService
 * stays hardcoded in index.ts until Phase 5 extracts it into its own package.
 */

/** Duck-typed — mirrors the `ChatAgent` interface exported from the
 *  Orchestrator. Kept narrow here to avoid a circular import between the
 *  platform layer and the services layer. Whatever the Orchestrator exports
 *  as `ChatAgent` has at least `chat()` and `chatStream()`; the registry
 *  treats the wrapper pipeline as opaque `TAgent`. */
export type ChatAgentWrapper<TAgent> = (inner: TAgent) => TAgent;

interface WrapperEntry<TAgent> {
  readonly wrap: ChatAgentWrapper<TAgent>;
  readonly label: string;
}

/** Type-erased read-only view for diagnostic endpoints. The runtime
 *  introspection route reaches the registry through this interface to
 *  avoid leaking the generic `TAgent` parameter across the route/service
 *  layer boundary. */
export interface ChatAgentWrapIntrospection {
  count(): number;
  labels(): readonly string[];
}

export class ChatAgentWrapRegistry<TAgent> implements ChatAgentWrapIntrospection {
  private readonly entries: WrapperEntry<TAgent>[] = [];

  register(wrap: ChatAgentWrapper<TAgent>, label: string): () => void {
    const entry: WrapperEntry<TAgent> = { wrap, label };
    this.entries.push(entry);
    return () => {
      const idx = this.entries.indexOf(entry);
      if (idx >= 0) this.entries.splice(idx, 1);
    };
  }

  /** Compose the wrapper chain around the base agent. Innermost = base
   *  (called last in the wrapper's own logic); outermost = last-registered. */
  compose(base: TAgent): TAgent {
    let out = base;
    for (const entry of this.entries) {
      out = entry.wrap(out);
    }
    return out;
  }

  labels(): readonly string[] {
    return this.entries.map((e) => e.label);
  }

  count(): number {
    return this.entries.length;
  }
}
