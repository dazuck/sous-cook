"use client";

import { forwardRef, ButtonHTMLAttributes, ReactNode } from "react";
import Link from "next/link";

type ButtonVariant = "primary" | "secondary" | "ghost";
type ButtonSize = "sm" | "md" | "lg";

interface ButtonBaseProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Optional icon to show before the label */
  leftIcon?: ReactNode;
  /** Optional icon to show after the label */
  rightIcon?: ReactNode;
  /** Full width button */
  fullWidth?: boolean;
  /** Loading state */
  loading?: boolean;
  /** If provided, renders as a Link */
  href?: string;
  children: ReactNode;
}

type ButtonProps = ButtonBaseProps &
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, keyof ButtonBaseProps>;

// Design system pills: ember for the one act a screen is
// for, sand for the rest, ink-soft text for the quiet ones. Colour answers a
// press; nothing scales, slides or casts a shadow. The ember act waits in
// sand with ink-soft text until it can be acted on, never as faded ember
// (§1); the others fade.
const PRESSED = "active:bg-[color-mix(in_oklab,var(--sand),var(--ink)_8%)]";
const variantStyles: Record<ButtonVariant, string> = {
  primary:
    "bg-ember text-paper active:bg-ember-700 disabled:bg-sand disabled:text-ink-soft disabled:border-transparent",
  secondary: `bg-sand text-ink ${PRESSED} disabled:bg-sand disabled:text-ink-soft disabled:border-transparent`,
  ghost: `text-ink-soft ${PRESSED} disabled:bg-sand disabled:text-ink-soft disabled:border-transparent`,
};

const sizeStyles: Record<ButtonSize, string> = {
  sm: "px-[calc(20*var(--cpx))] py-[var(--space-2)] text-[length:var(--type-meta)] leading-tight",
  md: "px-[calc(28*var(--cpx))] py-[var(--space-3)] text-[length:var(--type-meta)] leading-tight",
  lg: "px-[calc(36*var(--cpx))] py-[var(--space-4)] text-[length:var(--type-meta)] leading-tight",
};

// Icon size mapping
const iconSizeClasses: Record<ButtonSize, string> = {
  sm: "text-[length:var(--type-meta)]",
  md: "text-[length:var(--type-meta)]",
  lg: "text-[length:var(--type-chip)]",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    {
      variant = "primary",
      size = "md",
      leftIcon,
      rightIcon,
      fullWidth = false,
      loading = false,
      href,
      disabled,
      className = "",
      children,
      ...props
    },
    ref,
  ) {
    const baseStyles = `
      rounded-full font-[family-name:var(--font-text)] font-semibold
      transition-colors duration-[320ms] ease-[var(--ease)]
      flex items-center justify-center gap-2
      min-h-[var(--target)] cursor-pointer
      focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink
      disabled:cursor-not-allowed
    `;

    const combinedClassName = `
      ${baseStyles}
      ${variantStyles[variant]}
      ${sizeStyles[size]}
      ${fullWidth ? "w-full" : ""}
      ${className}
    `.trim();

    const content = (
      <>
        {loading ? (
          <span
            aria-hidden
            className="block size-[calc(14*var(--cpx))] shrink-0 animate-dot-breathe rounded-full bg-current motion-reduce:animate-none"
          />
        ) : (
          leftIcon && <span className={iconSizeClasses[size]}>{leftIcon}</span>
        )}
        {children}
        {rightIcon && !loading && (
          <span className={iconSizeClasses[size]}>{rightIcon}</span>
        )}
      </>
    );

    if (href && !disabled) {
      return (
        <Link href={href} className={combinedClassName}>
          {content}
        </Link>
      );
    }

    return (
      <button
        ref={ref}
        disabled={disabled || loading}
        className={combinedClassName}
        {...props}
      >
        {content}
      </button>
    );
  },
);

export default Button;
