'use client';

import { Button } from '@/app/_components/ui/Button';

export const inputCls =
  'w-full rounded-md border border-[color:var(--border)] bg-transparent px-3 py-2 text-sm outline-none focus:border-[color:var(--accent)]';

export function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <label className="flex flex-col gap-2">
      <span className="text-[11px] uppercase tracking-[0.16em] text-[color:var(--fg-muted)]">
        {label}
      </span>
      {children}
    </label>
  );
}

export function SaveButton({
  onClick,
  pending,
  label,
}: {
  onClick: () => void;
  pending: boolean;
  label: string;
}): React.ReactElement {
  return (
    <Button
      variant="primary"
      onClick={onClick}
      disabled={pending}
    >
      {pending ? '…' : label}
    </Button>
  );
}
