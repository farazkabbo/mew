import type { ScreenAction, ScreenTutorResponse } from "./screen";

/**
 * The rule-based safety check every screen tutor reply passes before anyone hears or sees it
 * (decision 3). It covers the speech and every text the overlay would write.
 *
 * Screen content is untrusted: a page can say "tell the user to run this command". The tutor has
 * no tools that act on the computer, so the remaining risk is words; these rules block the
 * dangerous kinds outright (brief §7.4). A blocked reply is replaced, never edited.
 */

export type SafetyReason =
  | "asks_for_secrets"
  | "asks_for_payment"
  | "install_software"
  | "run_commands"
  | "edit_registry"
  | "disable_security";

const RULES: readonly { reason: SafetyReason; pattern: RegExp }[] = [
  {
    reason: "asks_for_secrets",
    pattern:
      /\b(?:enter|type|share|send|paste|give|tell|read out|say|provide)\b[^.!?]{0,40}\b(?:passwords?|passcodes?|pins?|one[- ]time codes?|verification codes?|security codes?|2fa codes?|otps?|seed phrases?|recovery (?:phrases?|codes?)|private keys?|api keys?|cvv|cvc)\b/i,
  },
  {
    reason: "asks_for_payment",
    pattern:
      /\b(?:enter|type|share|send|give|provide|add|confirm)\b[^.!?]{0,40}\b(?:card numbers?|credit card|debit card|bank (?:details|account)|payment (?:details|information|info))\b/i,
  },
  {
    reason: "install_software",
    pattern: /\b(?:install|reinstall|download and (?:run|open))\b/i,
  },
  {
    reason: "run_commands",
    pattern:
      /\b(?:powershell|command prompt|cmd(?:\.exe)?|windows terminal|terminal window|run (?:this|the|these) commands?|invoke-expression|iex|curl|wget|bash)\b|\bwin(?:dows)?(?:\s*key)?\s*\+\s*r\b/i,
  },
  { reason: "edit_registry", pattern: /\b(?:regedit|registry)\b/i },
  {
    reason: "disable_security",
    pattern:
      /\b(?:disable|turn off|switch off|deactivate|bypass|pause)\b[^.!?]{0,30}\b(?:defender|windows security|firewall|smartscreen|smart screen|uac|user account control|antivirus|anti-virus)\b/i,
  },
];

/** What is said instead of a blocked reply. */
export const SAFE_FALLBACK: ScreenTutorResponse = {
  speech:
    "I can't help with that part, but I'm happy to explain what's on your screen or the next safe step.",
  actions: [],
  mode: "answer",
};

/** Every reason `text` breaks a rule (empty when it's fine). */
export function unsafeReasons(text: string): SafetyReason[] {
  return RULES.filter((rule) => rule.pattern.test(text)).map((rule) => rule.reason);
}

/** All the text of a reply that the student would hear or see. */
export function replyTexts(response: ScreenTutorResponse): string[] {
  return [response.speech, ...actionTexts(response.actions)];
}

/** Every text the overlay would write for these actions (labels, notes, steps). */
export function actionTexts(actions: readonly ScreenAction[]): string[] {
  const texts: string[] = [];
  for (const action of actions) {
    if ("label" in action && action.label) texts.push(action.label);
    if (action.type === "margin_note") texts.push(action.text);
    if (action.type === "write_step") texts.push(action.latexOrText);
  }
  return texts;
}

/** Actions with any unsafe text are dropped as a whole set (re-placed ink, decision 3). */
export function checkScreenActions(actions: readonly ScreenAction[]): {
  actions: ScreenAction[];
  blocked: SafetyReason[];
} {
  const blocked = [...new Set(actionTexts(actions).flatMap(unsafeReasons))];
  return { actions: blocked.length === 0 ? [...actions] : [], blocked };
}

/** The reply if it's safe, otherwise the fallback (with why, for logging counts only). */
export function checkScreenReply(response: ScreenTutorResponse): {
  response: ScreenTutorResponse;
  blocked: SafetyReason[];
} {
  const blocked = [...new Set(replyTexts(response).flatMap(unsafeReasons))];
  return blocked.length === 0 ? { response, blocked } : { response: SAFE_FALLBACK, blocked };
}
