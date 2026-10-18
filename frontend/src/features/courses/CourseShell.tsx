import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

/** Calm, editorial page frame for the course screens. */
export function CourseShell({
  back,
  title,
  subtitle,
  children,
}: {
  back: { href: string; label: string };
  title: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="min-h-dvh bg-paper text-ink">
      <main className="mx-auto max-w-3xl px-6 py-10 sm:py-14">
        <Link
          href={back.href}
          className="inline-flex items-center gap-1.5 text-sm text-ink-muted hover:text-ink"
        >
          <ArrowLeft className="size-4" aria-hidden />
          {back.label}
        </Link>
        <h1 className="mt-6 font-serif text-4xl tracking-tight sm:text-5xl">{title}</h1>
        {subtitle && <div className="mt-3 text-ink-muted">{subtitle}</div>}
        <div className="mt-10">{children}</div>
      </main>
    </div>
  );
}

export function StatusPill({ status }: { status: string }) {
  const tone =
    status === "ready"
      ? "bg-check/15 text-check"
      : status === "failed"
        ? "bg-error/15 text-error"
        : "bg-accent/15 text-accent";
  const label =
    status === "processing" ? "Building" : status === "review" ? "Needs review" : status;
  return (
    <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium capitalize ${tone}`}>
      {label}
    </span>
  );
}
