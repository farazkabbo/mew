import Link from "next/link";

import { buttonClass, type ButtonVariant } from "@/components/ui/Button";

export type TonightRow = {
  id: string;
  title: string;
  detail: string;
  action: { label: string; variant: ButtonVariant } & ({ run(): void } | { href: string });
};

/**
 * Tonight (docs/NEB_APP_UI.md §5.1): an index card (a red rule at the top, blue rules under it)
 * with at most 3 things to do, in order: checks due, where you left off, loose pages to file, an
 * exam soon. Nothing to do: "All clear."
 */
export function TonightCard({ rows }: { rows: readonly TonightRow[] }) {
  return (
    <section
      aria-labelledby="desk-tonight"
      data-testid="tonight"
      className="rounded-[4px] px-[22px] pt-[22px] pb-[18px] shadow-[0_1px_0_var(--line),0_10px_24px_-14px_#5F5A5055]"
      style={{
        backgroundColor: "var(--paper-hi)",
        backgroundImage:
          "linear-gradient(var(--paper-hi) 46px, var(--margin-red) 46px, var(--margin-red) 47px, transparent 47px), repeating-linear-gradient(transparent 0 33px, var(--rule) 33px 34px)",
        backgroundPosition: "0 0, 0 47px",
      }}
    >
      <h2 id="desk-tonight" className="mb-6 font-serif text-[28px] leading-none">
        Tonight
      </h2>
      {rows.length === 0 ? (
        <p className="pb-2 text-[15px]">All clear. Open a notebook and write.</p>
      ) : (
        <ul className="flex flex-col gap-3.5">
          {rows.map((row) => (
            <li key={row.id} className="flex items-center gap-3" data-testid={`tonight-${row.id}`}>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[15px] font-semibold">{row.title}</div>
                <div className="text-[13px] text-muted">{row.detail}</div>
              </div>
              {"href" in row.action ? (
                <Link
                  href={row.action.href}
                  className={buttonClass(row.action.variant, {
                    className: "shrink-0 font-semibold",
                  })}
                >
                  {row.action.label}
                </Link>
              ) : (
                <button
                  type="button"
                  onClick={row.action.run}
                  className={buttonClass(row.action.variant, {
                    className: "shrink-0 font-semibold",
                  })}
                >
                  {row.action.label}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
