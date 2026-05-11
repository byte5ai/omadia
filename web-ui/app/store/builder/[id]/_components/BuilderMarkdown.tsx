'use client';

import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * Workspace-Markdown.
 *
 * Same GitHub-flavored renderer the rest of the dashboard uses, with one
 * targeted override: a numbered list whose every item leads with a
 * `<strong>` tag (e.g. `1. **Scope**: Soll der Agent …`) renders as a grid
 * of cards instead of a plain `<ol>`. The BuilderAgent tends to issue
 * multi-question architecture-fork prompts in exactly that shape and the
 * card layout makes them scannable instead of a wall of bullets.
 *
 * Scoped to the builder workspace because we can't change the main-chat
 * Markdown surface without auditing every other consumer first.
 */
export function BuilderMarkdown({ source }: { source: string }): React.ReactElement {
  return (
    <div className="md-view">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          ol: ({ children }) => {
            const items = Children.toArray(children).filter(isValidElement);
            const choiceCards = tryRenderChoiceCards(items as ReactElement[]);
            if (choiceCards) return choiceCards;
            return <ol>{children}</ol>;
          },
        }}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}

/**
 * Returns a card grid if every list item leads with a `<strong>` and there
 * are at least two items; otherwise `null` so the caller falls back to a
 * regular `<ol>`. We intentionally do not require a colon after the strong
 * tag — the renderer is fine with `**Foo**: …` as well as `**Foo**` followed
 * by a paragraph.
 */
function tryRenderChoiceCards(items: ReactElement[]): React.ReactElement | null {
  if (items.length < 2) return null;
  const allLeadWithStrong = items.every((item) => {
    const props = item.props as { children?: ReactNode };
    return liLeadsWithStrong(props.children);
  });
  if (!allLeadWithStrong) return null;

  return (
    <div className="my-3 flex flex-col gap-2">
      {items.map((item, i) => {
        const props = item.props as { children?: ReactNode };
        return (
          <div
            key={i}
            className="rounded-[10px] border border-[color:var(--divider)] bg-[color:var(--bg-elevated)] px-3 py-2.5 text-[12px] leading-snug text-[color:var(--fg-strong)] transition-colors hover:border-[color:var(--accent)]"
          >
            <div className="flex items-baseline gap-2">
              <span className="font-mono-num shrink-0 text-[10px] font-semibold uppercase tracking-[0.16em] text-[color:var(--fg-subtle)]">
                {String(i + 1).padStart(2, '0')}
              </span>
              <div className="md-view-card flex-1">{props.children}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function liLeadsWithStrong(children: ReactNode): boolean {
  const arr = Children.toArray(children);
  for (const node of arr) {
    if (typeof node === 'string') {
      if (node.trim().length === 0) continue;
      return false;
    }
    if (isValidElement(node)) {
      // react-markdown emits intrinsic strings ('strong'/'p'/...) as the
      // element type — react-element types are union of string | function.
      const t = (node as ReactElement).type;
      if (t === 'strong') return true;
      // Sometimes react-markdown wraps content in <p>, especially with
      // gfm — descend one level.
      if (t === 'p') {
        const childProps = (node as ReactElement).props as {
          children?: ReactNode;
        };
        return liLeadsWithStrong(childProps.children);
      }
      return false;
    }
  }
  return false;
}
