import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { greeting } from "./Desk";
import { DeskCover, NewNotebookCover } from "./DeskCover";
import { TonightCard } from "./TonightCard";

const at = (hour: number) => new Date(2026, 9, 28, hour, 30).getTime();

describe("the desk (NEB_APP_UI §5.1)", () => {
  it("greets by the time of day, and late at night", () => {
    expect(greeting(at(8), "Faraz")).toBe("Good morning, Faraz.");
    expect(greeting(at(14), "Faraz")).toBe("Good afternoon, Faraz.");
    expect(greeting(at(20), "Faraz")).toBe("Good evening, Faraz.");
    expect(greeting(at(23), "Faraz")).toBe("Late one, Faraz.");
    expect(greeting(at(2), null)).toBe("Late one.");
  });

  it("Tonight says all clear with nothing to do, and shows at most what it's given", () => {
    expect(renderToStaticMarkup(<TonightCard rows={[]} />)).toContain("All clear.");
    const html = renderToStaticMarkup(
      <TonightCard
        rows={[
          {
            id: "checks",
            title: "2 quick checks",
            detail: "about 4 min",
            action: { label: "Start", variant: "neb", run: () => undefined },
          },
          {
            id: "exam",
            title: "Physics exam in 3 days",
            detail: "its reviews come first",
            action: { label: "Plan", variant: "ghost", href: "/review" },
          },
        ]}
      />,
    );
    expect(html).toContain("2 quick checks");
    // Start is offered by neb (violet); Plan is the student's own (ink outline).
    expect(html).toMatch(/bg-neb[^"]*"[^>]*>Start</);
    expect(html).toContain('href="/review"');
  });

  it("a cover says what it is, and its sticky note only when checks are due", () => {
    const cover = (due: number) =>
      renderToStaticMarkup(
        <DeskCover
          name="Physics"
          color="#7DA4AF"
          meta="5 chapters · 38 pages"
          tabs={3}
          due={due}
          last="Projectiles · 1 h ago"
          onOpen={() => undefined}
        />,
      );
    expect(cover(2)).toContain('aria-label="Physics, 5 chapters · 38 pages, 2 checks due"');
    expect(cover(2)).toContain("2 checks");
    expect(cover(0)).not.toContain("checks due");
    expect(cover(0)).toContain("Projectiles · 1 h ago");
  });

  it("a new notebook is named first, always", () => {
    expect(renderToStaticMarkup(<NewNotebookCover onNew={() => undefined} />)).toContain(
      "name it first, always",
    );
    expect(renderToStaticMarkup(<NewNotebookCover onNew={() => undefined} first />)).toContain(
      "What are you studying?",
    );
  });

  it("a cover's ribbon shows what stayed, hidden at 0; Tonight says this week's (U6)", () => {
    const cover = (stayed: number) =>
      renderToStaticMarkup(
        <DeskCover
          name="Physics"
          color="#7DA4AF"
          meta="5 chapters · 38 pages"
          tabs={3}
          due={0}
          stayed={stayed}
          last="Projectiles · 1 h ago"
          onOpen={() => undefined}
        />,
      );
    expect(cover(34)).toContain('data-testid="stayed-ribbon"');
    expect(cover(34)).toContain("38 pages, 34 stayed");
    expect(cover(0)).not.toContain("stayed-ribbon");
    expect(renderToStaticMarkup(<TonightCard rows={[]} stayedWeek={12} />)).toContain(
      "stayed this week: 12",
    );
    expect(renderToStaticMarkup(<TonightCard rows={[]} />)).not.toContain("stayed this week");
  });
});
