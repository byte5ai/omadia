'use client';

import { Plus } from 'lucide-react';
import { useCallback, useMemo } from 'react';

import {
  detectType,
  ensureTopLevelObject,
  isValidPropertyKey,
  type JsonSchemaNode,
} from '../../../../_lib/jsonSchemaShape';

import { ToolInputSchemaRow } from './ToolInputSchemaRow';

interface ToolInputSchemaBuilderProps {
  /** Current input schema (may be undefined for fresh tools). */
  value: Record<string, unknown> | undefined;
  /** Called with the new shape on every edit. The caller is responsible
   *  for emitting the JsonPatch. */
  onChange: (next: Record<string, unknown>) => void;
  /** Recursion depth — purely visual. */
  depth?: number;
}

/**
 * B.11-3: Form-driven JSON-Schema builder for a tool's input shape.
 *
 * The top level is always an object (matches what the LLM tool-call
 * contract expects). The component receives a controlled value and
 * fires `onChange` with the new shape on every edit; recursion happens
 * for nested object / array-of-object types.
 *
 * Patterns out of MVP scope (oneOf, $ref, polymorphic schemas) are
 * preserved on round-trip via JsonSchemaNode's index-signature spread —
 * so the user can paste a complex schema in the raw-JSON tab (B.11-4)
 * and the form view simply degrades to read-only for the unknown bits.
 */
export function ToolInputSchemaBuilder({
  value,
  onChange,
  depth = 0,
}: ToolInputSchemaBuilderProps): React.ReactElement {
  const node = useMemo(() => ensureTopLevelObject(value), [value]);
  const properties = node.properties ?? {};
  const required = node.required ?? [];
  const keys = Object.keys(properties);

  const setProperty = useCallback(
    (key: string, next: JsonSchemaNode): void => {
      const nextProps: Record<string, JsonSchemaNode> = { ...properties };
      nextProps[key] = next;
      onChange({ ...node, properties: nextProps });
    },
    [node, properties, onChange],
  );

  const renameProperty = useCallback(
    (oldKey: string, newKey: string): void => {
      if (oldKey === newKey) return;
      const nextProps: Record<string, JsonSchemaNode> = {};
      // Preserve insertion order — the LLM uses property order as a
      // soft hint for arg ordering.
      for (const k of keys) {
        if (k === oldKey) {
          nextProps[newKey] = properties[oldKey] as JsonSchemaNode;
        } else {
          nextProps[k] = properties[k] as JsonSchemaNode;
        }
      }
      const nextRequired = required.map((r) => (r === oldKey ? newKey : r));
      onChange({ ...node, properties: nextProps, required: nextRequired });
    },
    [keys, properties, required, node, onChange],
  );

  const removeProperty = useCallback(
    (key: string): void => {
      const nextProps: Record<string, JsonSchemaNode> = { ...properties };
      delete nextProps[key];
      const nextRequired = required.filter((r) => r !== key);
      onChange({ ...node, properties: nextProps, required: nextRequired });
    },
    [properties, required, node, onChange],
  );

  const toggleRequired = useCallback(
    (key: string, next: boolean): void => {
      const set = new Set(required);
      if (next) {
        set.add(key);
      } else {
        set.delete(key);
      }
      onChange({ ...node, required: Array.from(set) });
    },
    [node, required, onChange],
  );

  const addProperty = useCallback((): void => {
    let n = keys.length + 1;
    let candidate = `field_${String(n)}`;
    while (Object.prototype.hasOwnProperty.call(properties, candidate)) {
      n += 1;
      candidate = `field_${String(n)}`;
    }
    setProperty(candidate, { type: 'string' });
  }, [keys.length, properties, setProperty]);

  return (
    <div className="space-y-1.5">
      {keys.length === 0 ? (
        <p className="rounded border border-dashed border-[color:var(--border)] bg-[color:var(--bg)] px-3 py-2 text-[11px] italic text-[color:var(--fg-muted)]">
          Keine Properties — Tool akzeptiert leeres Input-Objekt.
        </p>
      ) : (
        keys.map((k) => {
          const child = properties[k] as JsonSchemaNode;
          const t = detectType(child);
          const childRequired = required.includes(k);
          return (
            <div key={k} className="space-y-1">
              <ToolInputSchemaRow
                fieldKey={k}
                node={child}
                required={childRequired}
                siblingKeys={keys}
                depth={depth}
                onRename={(nk) => {
                  if (!isValidPropertyKey(nk)) return;
                  if (
                    nk !== k &&
                    Object.prototype.hasOwnProperty.call(properties, nk)
                  ) {
                    return;
                  }
                  renameProperty(k, nk);
                }}
                onChangeNode={(nextNode) => setProperty(k, nextNode)}
                onRemove={() => removeProperty(k)}
                onToggleRequired={(next) => toggleRequired(k, next)}
              />
              {t === 'object' ? (
                <ToolInputSchemaBuilder
                  value={child as Record<string, unknown>}
                  onChange={(next) =>
                    setProperty(k, next as unknown as JsonSchemaNode)
                  }
                  depth={depth + 1}
                />
              ) : null}
              {t === 'array' &&
              detectType(child.items as JsonSchemaNode) === 'object' ? (
                <ToolInputSchemaBuilder
                  value={child.items as Record<string, unknown>}
                  onChange={(next) =>
                    setProperty(k, {
                      ...child,
                      items: next as unknown as JsonSchemaNode,
                    })
                  }
                  depth={depth + 1}
                />
              ) : null}
            </div>
          );
        })
      )}
      <button
        type="button"
        onClick={addProperty}
        className="inline-flex items-center gap-1 rounded border border-[color:var(--border)] bg-[color:var(--bg)] px-2 py-1 text-[11px] font-semibold text-[color:var(--fg-strong)] hover:border-[color:var(--accent)]"
      >
        <Plus className="size-3" aria-hidden />
        Property
      </button>
    </div>
  );
}
