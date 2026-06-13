'use client';

import { type HTMLMotionProps, motion, useReducedMotion } from 'framer-motion';
import { forwardRef } from 'react';

import { cn } from '../../_lib/cn';

/**
 * Lume Button — the canonical interactive button (omadia visual-spec §4.2).
 *
 * Why a component instead of per-call className soup: the spec defines five
 * normative button variants plus a focus and busy recipe. Encoding them once
 * keeps every button on-spec, gives real press/hover motion (§6.4) through
 * Framer Motion's `whileTap` / `whileHover` instead of CSS-only state, and
 * keeps the markup a plain `<button>` (type, disabled, focus, aria all real).
 *
 * Visual recipes (gradient fill, two-stop glow, directional border, inset
 * top-highlight) come from the Lume material layer in globals.css, which
 * matches the same token utility classes this component emits — so the look
 * stays centralized at the token tier and the component owns structure + feel.
 *
 * Variants (§4.2):
 *   primary    accent gradient fill + two-stop glow (default CTA)
 *   secondary  raised surface + directional border
 *   ghost      transparent; hover paints accent.subtle
 *   danger     transparent + error edge + error text (no fill, no glow)
 *
 * Busy (§7.3 — the single spinner exception): the label is replaced with a
 * verb plus animated dots, never a spinning glyph. Pass `busy` + `busyLabel`.
 */

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg' | 'icon';

export interface ButtonProps extends Omit<HTMLMotionProps<'button'>, 'children'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Pill radius (badge/CTA chips) instead of the default radius.md corner. */
  pill?: boolean;
  /** Stretch to the container width (form submits, full-width CTAs). */
  fullWidth?: boolean;
  /** §7.3 in-flight: replaces the label with `busyLabel` + animated dots. */
  busy?: boolean;
  busyLabel?: string;
  children?: React.ReactNode;
}

const BASE =
  'relative inline-flex items-center justify-center gap-2 rounded-md font-medium ' +
  'whitespace-nowrap select-none outline-none transition-colors ' +
  'disabled:cursor-not-allowed disabled:opacity-60';

const VARIANT: Record<ButtonVariant, string> = {
  // The material layer turns these token fills into the §4.2 recipes:
  // primary -> accent gradient + lit top border + two-stop glow + layered focus
  primary: 'bg-[color:var(--accent)] text-[color:var(--fg-on-dark)]',
  // secondary -> raised-surface gradient + directional border + inset highlight
  secondary:
    'border border-[color:var(--border)] bg-[color:var(--bg-elevated)] text-[color:var(--fg)] ' +
    'hover:border-[color:var(--border-strong)]',
  // ghost -> transparent, accent.subtle wash on hover (no glow until hover)
  ghost:
    'bg-transparent text-[color:var(--fg)] hover:bg-[color:var(--accent-subtle)] hover:text-[color:var(--accent)]',
  // danger -> transparent + error edge + error text; the error is the signal
  danger:
    'border border-[color:var(--danger-edge)] bg-transparent text-[color:var(--danger)] hover:bg-[color:var(--danger)]/8',
};

const SIZE: Record<ButtonSize, string> = {
  sm: 'px-3 py-1 text-xs',
  md: 'px-4 py-2 text-sm',
  lg: 'px-6 py-3 text-base',
  icon: 'p-2',
};

// §6.4 hover / press feel. easing.standard, motion.quick (100ms).
const TAP = { scale: 0.97 } as const;
const HOVER = { y: -1 } as const;
const FEEL_TRANSITION = { duration: 0.1, ease: [0.22, 0.61, 0.36, 1] } as const;

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'primary',
    size = 'md',
    pill = false,
    fullWidth = false,
    busy = false,
    busyLabel,
    disabled,
    type = 'button',
    className,
    children,
    ...rest
  },
  ref,
) {
  const reduce = useReducedMotion();
  const isDisabled = disabled || busy;
  // No press/hover transform when disabled, busy, or the user asked for less
  // motion — the glow and color transitions (CSS) still carry the state.
  const animate = !isDisabled && !reduce;

  return (
    <motion.button
      ref={ref}
      type={type}
      disabled={isDisabled}
      aria-busy={busy || undefined}
      whileTap={animate ? TAP : undefined}
      whileHover={animate ? HOVER : undefined}
      transition={FEEL_TRANSITION}
      className={cn(
        BASE,
        VARIANT[variant],
        SIZE[size],
        pill ? 'rounded-full' : 'rounded-md',
        fullWidth && 'w-full',
        className,
      )}
      {...rest}
    >
      {busy ? (
        <span className="inline-flex items-center">
          {busyLabel ?? children}
          <span className="lume-busy-dots" aria-hidden />
        </span>
      ) : (
        children
      )}
    </motion.button>
  );
});
