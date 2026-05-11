'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * Thin wrapper that renders GitHub-flavored markdown with our project-local
 * `.md-view` class. Global styles in globals.css handle typography. Keeping
 * the component dumb means the streaming chat can re-render cheaply as the
 * source string grows.
 */
export function Markdown({ source }: { source: string }): React.ReactElement {
  return (
    <div className="md-view">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{source}</ReactMarkdown>
    </div>
  );
}
