import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";

/**
 * Monochrome primitives. Every surface here is black or grey; every piece of
 * text is white or grey. The only "accent" available is inversion — a white
 * fill with black text — reserved for the single primary action on a screen.
 */

export function Card({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`border-line bg-surface rounded-xl border ${className}`}
    >
      {children}
    </div>
  );
}

export function CardHeader({
  title,
  description,
  action,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="border-line flex items-start justify-between gap-4 border-b px-5 py-4">
      <div className="min-w-0">
        <h2 className="text-text text-sm font-medium">{title}</h2>
        {description ? (
          <p className="text-text-dim mt-1 text-sm">{description}</p>
        ) : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

type ButtonVariant = "primary" | "secondary" | "ghost";

const buttonBase =
  "inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-45";

const buttonVariants: Record<ButtonVariant, string> = {
  // Inverted: white fill, black label. One per screen.
  primary: "bg-text text-ink hover:bg-white",
  secondary:
    "border border-line-hi bg-surface-hi text-text hover:bg-[#242424]",
  ghost: "text-text-dim hover:text-text hover:bg-surface",
};

export function Button({
  variant = "primary",
  className = "",
  ...props
}: ComponentProps<"button"> & { variant?: ButtonVariant }) {
  return (
    <button
      {...props}
      className={`${buttonBase} ${buttonVariants[variant]} ${className}`}
    />
  );
}

export function ButtonLink({
  variant = "primary",
  className = "",
  ...props
}: ComponentProps<typeof Link> & { variant?: ButtonVariant }) {
  return (
    <Link
      {...props}
      className={`${buttonBase} ${buttonVariants[variant]} ${className}`}
    />
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="text-text-dim block text-xs font-medium tracking-wide uppercase">
        {label}
      </span>
      <div className="mt-2">{children}</div>
      {hint ? <p className="text-text-faint mt-2 text-xs">{hint}</p> : null}
    </label>
  );
}

export function Input({ className = "", ...props }: ComponentProps<"input">) {
  return (
    <input
      {...props}
      className={`border-line bg-ink-raised text-text placeholder:text-text-faint w-full rounded-lg border px-3 py-2 text-sm outline-none focus:border-line-hi ${className}`}
    />
  );
}

/** Status pill — grey fill, white or grey text. Never colour-coded. */
export function Badge({
  children,
  tone = "muted",
}: {
  children: ReactNode;
  tone?: "muted" | "solid" | "outline";
}) {
  const tones = {
    muted: "bg-surface-hi text-text-dim border-transparent",
    solid: "bg-text text-ink border-transparent",
    outline: "bg-transparent text-text-dim border-line-hi",
  } as const;
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

/** A one-line error, in white on a grey field — legible without red. */
export function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <p
      role="alert"
      className="border-line-hi bg-surface-hi text-text rounded-lg border px-3 py-2 text-sm"
    >
      {children}
    </p>
  );
}

export function Mono({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <span className={`font-mono text-[13px] ${className}`}>{children}</span>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="px-5 py-14 text-center">
      <p className="text-text text-sm font-medium">{title}</p>
      <p className="text-text-dim mx-auto mt-2 max-w-sm text-sm">{description}</p>
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}
