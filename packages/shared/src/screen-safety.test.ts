import { describe, expect, it } from "vitest";

import type { ScreenTutorResponse } from "./screen";
import {
  checkScreenActions,
  checkScreenReply,
  SAFE_FALLBACK,
  unsafeReasons,
} from "./screen-safety";

const reply = (speech: string, actions: ScreenTutorResponse["actions"] = []) =>
  ({ speech, actions, mode: "answer" }) as const satisfies ScreenTutorResponse;

describe("screen reply safety", () => {
  it.each([
    ["Please type your password here so I can check it.", "asks_for_secrets"],
    ["Read out the verification code you got by text.", "asks_for_secrets"],
    ["Share your recovery phrase to restore the wallet.", "asks_for_secrets"],
    ["Enter your card number to continue the trial.", "asks_for_payment"],
    ["Install the helper extension the page recommends.", "install_software"],
    ["Download and run the fixer tool.", "install_software"],
    ["Open PowerShell and paste the command from the page.", "run_commands"],
    ["Press Win + R and type cmd.", "run_commands"],
    ["Run this command: iex (irm example.com)", "run_commands"],
    ["Open regedit and delete the key.", "edit_registry"],
    ["Turn off Windows Security for a minute.", "disable_security"],
    ["Disable SmartScreen so the file opens.", "disable_security"],
  ])("blocks %j", (speech, reason) => {
    expect(unsafeReasons(speech)).toContain(reason);
    const checked = checkScreenReply(reply(speech));
    expect(checked.response).toEqual(SAFE_FALLBACK);
    expect(checked.blocked).toContain(reason);
  });

  it.each([
    "Click Insert, then PivotTable.",
    "Type the total in cell B7 and press Enter.",
    "That button saves a copy under a new name.",
    "Your password field is hidden, which is good; let's look at the menu instead.",
    "Open the terminal panel in VS Code from the View menu.",
    "Pin this tab so it stays open.",
    "This is the same idea as forces and acceleration from your course.",
  ])("lets ordinary tutoring through: %j", (speech) => {
    expect(unsafeReasons(speech)).toEqual([]);
    expect(checkScreenReply(reply(speech)).response.speech).toBe(speech);
  });

  it("checks labels and notes the overlay would write, not just the speech", () => {
    const labelled = reply("Here's the next step.", [
      { type: "point_at", point: { x: 500, y: 500 }, label: "type password here" },
    ]);
    expect(checkScreenReply(labelled).response).toEqual(SAFE_FALLBACK);

    const box = { left: 10, top: 10, right: 20, bottom: 20 };
    const noted = reply("Look here.", [
      { type: "margin_note", text: "open powershell", besideBox: box },
    ]);
    expect(checkScreenReply(noted).blocked).toEqual(["run_commands"]);

    const step = reply("Try this first.", [
      { type: "write_step", latexOrText: "regedit → delete the key", besideBox: box },
    ]);
    expect(checkScreenReply(step).blocked).toEqual(["edit_registry"]);
  });

  it("drops a whole set of re-placed ink if any of its text is unsafe", () => {
    const box = { left: 10, top: 10, right: 20, bottom: 20 };
    const safe = [{ type: "margin_note", text: "Units first", besideBox: box }] as const;
    expect(checkScreenActions(safe)).toEqual({ actions: safe, blocked: [] });
    const unsafe = [
      ...safe,
      { type: "point_at", point: { x: 1, y: 1 }, label: "install this" },
    ] as const;
    expect(checkScreenActions(unsafe)).toEqual({ actions: [], blocked: ["install_software"] });
  });

  it("keeps a safe reply exactly as it was", () => {
    const safe = reply("Click here to add a chart.", [
      { type: "point_at", point: { x: 120, y: 40 }, label: "Insert" },
    ]);
    expect(checkScreenReply(safe)).toEqual({ response: safe, blocked: [] });
  });
});
