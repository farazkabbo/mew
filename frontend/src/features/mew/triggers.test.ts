import { beforeEach, describe, expect, it, vi } from "vitest";

import { type Clock, type Evaluation, MewTriggers } from "./triggers";

/** A manual clock: timers fire only when `advance` passes their due time. */
function fakeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { due: number; fn: () => void }>();
  const clock: Clock = {
    now: () => now,
    setTimeout: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { due: now + ms, fn });
      return id;
    },
    clearTimeout: (id) => timers.delete(id as number),
  };
  const advance = (ms: number) => {
    now += ms;
    for (const [id, timer] of [...timers]) {
      if (timer.due <= now) {
        timers.delete(id);
        timer.fn();
      }
    }
  };
  return { clock, advance };
}

let evaluate: ReturnType<typeof vi.fn<(e: Evaluation) => void>>;
let time: ReturnType<typeof fakeClock>;
let triggers: MewTriggers;

beforeEach(() => {
  evaluate = vi.fn<(e: Evaluation) => void>();
  time = fakeClock();
  triggers = new MewTriggers(evaluate, time.clock);
});

describe("utterances", () => {
  it("evaluates each finished utterance", () => {
    triggers.utterance("why does the force cancel out?");

    expect(evaluate).toHaveBeenCalledWith({
      trigger: "utterance",
      utterance: "why does the force cancel out?",
    });
  });

  it('treats "Hey Mew …" as a summon carrying the request', () => {
    triggers.utterance("hey mew what's next");

    expect(evaluate).toHaveBeenCalledWith({ trigger: "summon", utterance: "what's next" });
  });
});

describe("cooldown after the tutor speaks", () => {
  beforeEach(() => triggers.tutorFinished());

  it("drops acknowledgements but lets new questions and summons through", () => {
    triggers.utterance("okay thanks");
    triggers.utterance("why is it squared?");
    triggers.utterance("hey mew, again");

    expect(evaluate.mock.calls.map(([e]) => e.trigger)).toEqual(["utterance", "summon"]);
  });

  it("ends after 4 s", () => {
    time.advance(4000);
    triggers.utterance("okay so the next part");

    expect(evaluate).toHaveBeenCalledOnce();
  });
});

describe("pen pauses", () => {
  const write = (strokes: number) => {
    for (let i = 0; i < strokes; i++) {
      triggers.strokeAdded();
      time.advance(300);
    }
  };

  it("fires 1.5 s after the last of several strokes", () => {
    write(3);
    time.advance(1199);
    expect(evaluate).not.toHaveBeenCalled();

    time.advance(1);
    expect(evaluate).toHaveBeenCalledWith({ trigger: "pen_pause", utterance: "" });
  });

  it("does not fire for a single dot or tick", () => {
    write(1);
    time.advance(5000);

    expect(evaluate).not.toHaveBeenCalled();
  });

  it("is cancelled by speech", () => {
    write(3);
    triggers.speech();
    time.advance(5000);

    expect(evaluate).not.toHaveBeenCalled();
  });

  it("needs fresh writing before firing again", () => {
    write(3);
    time.advance(2000);
    write(1);
    time.advance(5000);

    expect(evaluate).toHaveBeenCalledOnce();
  });

  it("stays quiet during the cooldown", () => {
    triggers.tutorFinished();
    write(3);
    time.advance(1500);

    expect(evaluate).not.toHaveBeenCalled();
  });
});

describe("summon", () => {
  it("always evaluates, even in the cooldown", () => {
    triggers.tutorFinished();
    triggers.summon("is this right");

    expect(evaluate).toHaveBeenCalledWith({ trigger: "summon", utterance: "is this right" });
  });
});
