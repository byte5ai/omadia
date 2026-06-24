'use client';

import { useMemo, type ComponentProps } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { stripCitationMarkers } from '../_lib/citations';
import { MarkdownTable } from './MarkdownTable';

/**
 * Thin wrapper that renders GitHub-flavored markdown with our project-local
 * `.md-view` class. Global styles in globals.css handle typography. Keeping
 * the component dumb means the streaming chat can re-render cheaply as the
 * source string grows.
 *
 * Privacy Shield v4: when `highlightTerms` is given, every occurrence of
 * those values is wrapped in a violet chip. They are the real values the
 * server resolved behind the data-plane boundary — the data the LLM never
 * saw — so the asker can spot at a glance what was protected.
 */

type RehypePlugins = ComponentProps<typeof ReactMarkdown>['rehypePlugins'];

/** Minimal hast node shape — enough to walk and rewrite text nodes. */
interface HastNode {
  type: string;
  value?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

/**
 * Tailwind utilities for a Privacy-Shield-revealed value. Written as a
 * literal array so the Tailwind JIT picks the classes up from this file.
 */
const PII_REVEALED_CLASS: readonly string[] = [
  'rounded-sm',
  'bg-[color:var(--accent)]/10',
  'px-1',
  'text-[color:var(--accent)]',
  '',
  '',
];

/**
 * Build a rehype plugin that wraps every occurrence of `terms` in a violet
 * `<span>`. Longest term first so a term that contains another wins the scan.
 */
function buildHighlightPlugin(terms: readonly string[]): RehypePlugins {
  const sorted = [...new Set(terms)]
    .filter((t) => t.trim().length > 0)
    .sort((a, b) => b.length - a.length);
  if (sorted.length === 0) return undefined;

  function splitText(value: string): HastNode[] {
    const parts: HastNode[] = [];
    let buf = '';
    let i = 0;
    while (i < value.length) {
      const term = sorted.find((t) => value.startsWith(t, i));
      if (term !== undefined) {
        if (buf.length > 0) {
          parts.push({ type: 'text', value: buf });
          buf = '';
        }
        parts.push({
          type: 'element',
          tagName: 'span',
          properties: { className: [...PII_REVEALED_CLASS] },
          children: [{ type: 'text', value: term }],
        });
        i += term.length;
      } else {
        buf += value.charAt(i);
        i += 1;
      }
    }
    if (buf.length > 0) parts.push({ type: 'text', value: buf });
    return parts;
  }

  function walk(node: HastNode): void {
    const children = node.children;
    if (children === undefined) return;
    const next: HastNode[] = [];
    for (const child of children) {
      if (child.type === 'text' && typeof child.value === 'string') {
        next.push(...splitText(child.value));
      } else {
        walk(child);
        next.push(child);
      }
    }
    node.children = next;
  }

  return [() => (tree: unknown): void => walk(tree as HastNode)];
}

export function Markdown({
  source,
  highlightTerms,
}: {
  source: string;
  /** Privacy Shield v4 — real values to highlight as boundary-protected. */
  highlightTerms?: readonly string[];
}): React.ReactElement {
  const rehypePlugins = useMemo<RehypePlugins>(
    () =>
      highlightTerms && highlightTerms.length > 0
        ? buildHighlightPlugin(highlightTerms)
        : undefined,
    [highlightTerms],
  );
  // #131 — strip `[ref:nodeId]` citation markers before render. The verifier
  // uses them to attribute KG-evidence claims; the user just sees the prose.
  const displayed = useMemo(() => stripCitationMarkers(source), [source]);
  return (
    <div className="md-view">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={rehypePlugins}
        components={MARKDOWN_COMPONENTS}
      >
        {displayed}
      </ReactMarkdown>
    </div>
  );
}

/**
 * GFM table renderer override. Wraps every table in a scroll-container with
 * a "full view" toolbar — see {@link MarkdownTable}. Hoisted to module scope
 * so the components object is stable across re-renders (no needless tree
 * recomputation during streaming).
 */
const MARKDOWN_COMPONENTS: ComponentProps<typeof ReactMarkdown>['components'] =
  {
    table: ({ children, className }) => (
      <MarkdownTable className={className}>{children}</MarkdownTable>
    ),
  };
