'use client';

import { ChevronDown } from 'lucide-react';

import { Button } from '@/app/_components/ui/Button';

/**
 * Floating "jump to bottom" affordance for panes wired to useStickToBottom
 * (issue #404) — shown only while the user has detached from the bottom by
 * scrolling up during a stream.
 */
export function ScrollToBottomButton({
  visible,
  onClick,
  ariaLabel,
}: {
  visible: boolean;
  onClick: () => void;
  ariaLabel: string;
}): React.JSX.Element | null {
  if (!visible) return null;

  return (
    <Button
      type="button"
      variant="secondary"
      size="icon"
      pill
      onClick={onClick}
      aria-label={ariaLabel}
      className="absolute bottom-4 left-1/2 z-10 -translate-x-1/2 shadow-lg"
    >
      <ChevronDown className="size-4" aria-hidden />
    </Button>
  );
}
