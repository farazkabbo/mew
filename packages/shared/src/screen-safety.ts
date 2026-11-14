import type { CoachPlan, CoachVerdict } from "./coach";
import { type ScreenAction, type ScreenTutorResponse, sketchTexts } from "./screen";

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
  // French.
  {
    reason: "asks_for_secrets",
    pattern:
      /\b(?:entre[zr]?|saisi[sr]|saisissez|tape[zr]?|partage[zr]?|envoie[zr]?|envoyer|colle[zr]?|donne[zr]?|dites?|indique[zr]?|fournir|fournissez|communique[zr]?)\b[^.!?]{0,40}(?:mots? de passe|codes? (?:pin|secrets?|de s[ée]curit[ée]|de v[ée]rification|[àa] usage unique)|phrases? de (?:r[ée]cup[ée]ration|secours)|cl[ée]s? (?:api|priv[ée]es?)|cvv|cvc)/i,
  },
  {
    reason: "asks_for_payment",
    pattern:
      /\b(?:entre[zr]?|saisi[sr]|saisissez|tape[zr]?|partage[zr]?|envoie[zr]?|envoyer|donne[zr]?|fournir|fournissez|ajoute[zr]?|confirme[zr]?)\b[^.!?]{0,40}(?:num[ée]ros? de carte|cartes? (?:bancaires?|de cr[ée]dit|de d[ée]bit)|coordonn[ée]es bancaires|compte bancaire|informations? de paiement)/i,
  },
  {
    reason: "install_software",
    pattern:
      /\b(?:r[ée])?install(?:e[zr]?|ons)\b|\bt[ée]l[ée]charge[zr]?\b[^.!?]{0,15}\b(?:lance[zr]?|ex[ée]cute[zr]?|ouvre[zr]?|ouvrez)\b/i,
  },
  {
    reason: "run_commands",
    pattern:
      /invite de commandes?|\bex[ée]cute[zr]?\b[^.!?]{0,15}\bcommandes?\b|\blance[zr]?\b[^.!?]{0,15}\bcommandes?\b/i,
  },
  {
    reason: "edit_registry",
    pattern: /(?:base de registre|[ée]diteur du registre|registre windows)/i,
  },
  {
    reason: "disable_security",
    pattern:
      /\b(?:d[ée]sactive[zr]?|coupe[zr]?|contourne[zr]?|arr[êe]te[zr]?|suspend(?:re|ez))\b[^.!?]{0,30}(?:defender|s[ée]curit[ée] windows|pare-feu|smartscreen|contr[ôo]le de compte|antivirus|anti-virus)/i,
  },
  // Mandarin: no word boundaries, and the verb comes before the thing.
  {
    reason: "asks_for_secrets",
    pattern:
      /(?:输入|填写|键入|告诉|发送|提供|分享|粘贴|说出|念出|给我)[^。！？]{0,20}(?:密码|验证码|安全码|校验码|一次性代码|助记词|恢复短语|恢复码|私钥|API ?密钥|CVV|CVC|PIN)|(?:密码|验证码|安全码|校验码|助记词|恢复码|私钥|API ?密钥|CVV|CVC|PIN)[^。！？]{0,20}(?:输入|填写|键入|告诉|发送|提供|分享|粘贴|说出|念出|给我)/i,
  },
  {
    reason: "asks_for_payment",
    pattern:
      /(?:输入|填写|键入|告诉|发送|提供|分享|添加|确认)[^。！？]{0,20}(?:卡号|信用卡|借记卡|银行卡|银行账户|银行账号|支付信息|付款信息)|(?:卡号|信用卡|借记卡|银行卡|银行账户|银行账号|支付信息|付款信息)[^。！？]{0,20}(?:输入|填写|键入|告诉|发送|提供|分享|添加)/,
  },
  { reason: "install_software", pattern: /安装|下载并(?:运行|打开)/ },
  {
    reason: "run_commands",
    pattern: /命令提示符|终端窗口|(?:运行|执行)[^。！？]{0,6}命令/,
  },
  { reason: "edit_registry", pattern: /注册表/ },
  {
    reason: "disable_security",
    pattern:
      /(?:关闭|禁用|停用|绕过|暂停)[^。！？]{0,15}(?:Defender|Windows ?安全|防火墙|SmartScreen|用户账户控制|杀毒|防病毒)/i,
  },
  // Bengali: no word boundaries, and the verb comes after the thing.
  {
    reason: "asks_for_secrets",
    pattern:
      /(?:পাসওয়ার্ড|পিন|ওটিপি|OTP|যাচাইকরণ কোড|ভেরিফিকেশন কোড|সিকিউরিটি কোড|নিরাপত্তা কোড|রিকভারি (?:ফ্রেজ|কোড)|প্রাইভেট কী|এপিআই কী|সিভিভি|CVV)[^।!?]{0,30}(?:লিখুন|লিখে|টাইপ|দিন|দিয়ে|পাঠান|পাঠিয়ে|বলুন|জানান|শেয়ার|পেস্ট)/i,
  },
  {
    reason: "asks_for_payment",
    pattern:
      /(?:কার্ড নম্বর|কার্ডের নম্বর|ক্রেডিট কার্ড|ডেবিট কার্ড|ব্যাংক (?:অ্যাকাউন্ট|তথ্য)|পেমেন্ট(?:ের)? তথ্য)[^।!?]{0,30}(?:লিখুন|লিখে|টাইপ|দিন|দিয়ে|পাঠান|পাঠিয়ে|জানান|শেয়ার|যোগ করুন)/,
  },
  { reason: "install_software", pattern: /ইনস্টল|ডাউনলোড করে (?:চালান|খুলুন)/ },
  {
    reason: "run_commands",
    pattern: /কমান্ড প্রম্পট|টার্মিনাল|পাওয়ারশেল|কমান্ড[^।!?]{0,8}(?:চালান|চালিয়ে)/,
  },
  { reason: "edit_registry", pattern: /রেজিস্ট্রি/ },
  {
    reason: "disable_security",
    pattern:
      /(?:ডিফেন্ডার|উইন্ডোজ সিকিউরিটি|ফায়ারওয়াল|স্মার্টস্ক্রিন|অ্যান্টিভাইরাস)[^।!?]{0,30}(?:বন্ধ|নিষ্ক্রিয়|বাইপাস)/,
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
  return [...new Set(RULES.filter((rule) => rule.pattern.test(text)).map((rule) => rule.reason))];
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
    if (action.type === "sketch") texts.push(...sketchTexts(action.figure));
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

/**
 * Every reason a coach plan breaks a rule (S4): its title, intro and each step's texts, the
 * success conditions included (a goal that needs a command is refused whole, not edited).
 */
export function coachPlanReasons(plan: CoachPlan): SafetyReason[] {
  const texts = [
    plan.title,
    plan.intro,
    ...(plan.firstTarget?.label ? [plan.firstTarget.label] : []),
    ...plan.steps.flatMap((s) => [s.instruction, s.successCondition, s.hint, s.explicit]),
  ];
  return [...new Set(texts.flatMap(unsafeReasons))];
}

/** Every reason a step check's words (its redirect and the control's name) break a rule. */
export function coachVerdictReasons(verdict: Pick<CoachVerdict, "redirect" | "target">) {
  const texts = [verdict.redirect, verdict.target?.label].filter((t): t is string => !!t);
  return [...new Set(texts.flatMap(unsafeReasons))];
}

/** Every reason a circle-ask step's words (what's said and what's written) break a rule. */
export function circleStepReasons(step: { say: string; actions: readonly ScreenAction[] }) {
  return [...new Set([step.say, ...actionTexts(step.actions)].flatMap(unsafeReasons))];
}

/**
 * Every reason the rest of a circle-ask answer (kept in the notebook) breaks a rule. The question
 * as read is the student's own, so it isn't checked.
 */
export function circleAnswerReasons(answer: {
  summary: string;
  followUpQuestion: string | null;
  conceptHints: readonly string[];
}) {
  const texts = [
    answer.summary,
    ...(answer.followUpQuestion ? [answer.followUpQuestion] : []),
    ...answer.conceptHints,
  ];
  return [...new Set(texts.flatMap(unsafeReasons))];
}

/** The reply if it's safe, otherwise the fallback (with why, for logging counts only). */
export function checkScreenReply(response: ScreenTutorResponse): {
  response: ScreenTutorResponse;
  blocked: SafetyReason[];
} {
  const blocked = [...new Set(replyTexts(response).flatMap(unsafeReasons))];
  return blocked.length === 0 ? { response, blocked } : { response: SAFE_FALLBACK, blocked };
}
