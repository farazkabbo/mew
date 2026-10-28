import { type ButtonHTMLAttributes, forwardRef } from "react";

/**
 * Buttons (docs/NEB_APP_UI.md §3.5). Labels are verbs ("Resume", "Check my work"), never "OK".
 * - ink: the student's primary action;
 * - neb: only for what neb offers (Start checks, Check my work, why?, Show me);
 * - ghost: an ink outline;
 * - quiet: a hairline and muted text;
 * - danger: destructive, inside confirmations only.
 * 44 px tall (touch); `dense` is 36 px for desktop toolbars, still with a 44 px hit area.
 */
export type ButtonVariant = "ink" | "neb" | "ghost" | "quiet" | "danger";

const VARIANT: Record<ButtonVariant, string> = {
  ink: "bg-ink text-paper hover:opacity-90",
  neb: "bg-neb text-white hover:opacity-90",
  ghost: "border border-ink text-ink hover:bg-ink/5",
  quiet: "border border-line text-muted hover:text-ink hover:border-ink/40",
  danger: "border border-line text-danger hover:border-danger",
};

export function buttonClass(
  variant: ButtonVariant = "ink",
  { dense = false, className = "" }: { dense?: boolean; className?: string } = {},
): string {
  return [
    "relative inline-flex items-center justify-center gap-2 rounded-full font-medium",
    "transition-[opacity,background-color,border-color,color] duration-[120ms] ease-out",
    "disabled:pointer-events-none disabled:opacity-50",
    // The hit area stays 44 px when a dense button is drawn smaller.
    dense
      ? "h-9 px-3.5 text-sm after:absolute after:inset-x-0 after:-inset-y-1 after:content-['']"
      : "h-11 px-4 text-[15px]",
    VARIANT[variant],
    className,
  ].join(" ");
}

export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; dense?: boolean }
>(function Button({ variant = "ink", dense = false, className, type = "button", ...rest }, ref) {
  return (
    <button
      ref={ref}
      type={type}
      className={buttonClass(variant, { dense, ...(className ? { className } : {}) })}
      {...rest}
    />
  );
});
