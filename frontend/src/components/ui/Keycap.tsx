/**
 * A key, as on a keyboard (docs/NEB_APP_UI.md §3.6): a paper cap with a deeper bottom edge.
 * `pressed` shows it held down (neb's wash and border), e.g. while Ctrl + Alt are held.
 */
export type KeycapSize = "sm" | "md" | "lg" | "xl";

const SIZE: Record<KeycapSize, string> = {
  sm: "h-5 min-w-5 px-1.5 text-[11px] border-b-2",
  md: "h-[22px] min-w-[22px] px-1.5 text-xs border-b-2",
  lg: "h-[26px] min-w-[26px] px-2 text-xs border-b-[3px]",
  xl: "h-11 min-w-11 px-3 text-base border-b-4 rounded-[9px]",
};

export function Keycap({
  children,
  size = "md",
  pressed = false,
  className = "",
}: {
  children: React.ReactNode;
  size?: KeycapSize;
  pressed?: boolean;
  className?: string;
}) {
  return (
    <kbd
      data-pressed={pressed || undefined}
      className={[
        "inline-flex items-center justify-center rounded-[5px] border font-sans font-semibold",
        "transition-transform duration-[120ms] ease-out",
        SIZE[size],
        pressed
          ? "translate-y-0.5 border-neb border-b bg-neb-wash text-neb-ink"
          : "border-line bg-paper text-ink",
        className,
      ].join(" ")}
    >
      {children}
    </kbd>
  );
}

/** Keys joined the way the brief writes them: Ctrl, Alt, K → three caps. */
export function Keys({
  keys,
  size,
  pressed,
}: {
  keys: readonly string[];
  size?: KeycapSize;
  pressed?: boolean;
}) {
  return (
    <span className="inline-flex items-center gap-1">
      {keys.map((key) => (
        <Keycap key={key} {...(size ? { size } : {})} {...(pressed ? { pressed } : {})}>
          {key}
        </Keycap>
      ))}
    </span>
  );
}
