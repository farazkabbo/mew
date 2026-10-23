import "server-only";

import {
  checkScreenActions,
  renderReanchorInput,
  type ScreenAction,
  SCREEN_REANCHOR_PROMPT,
  type ScreenReanchorRequest,
  ScreenReanchorResponse,
} from "@mew/shared";

import { verifierModel } from "./env";
import { type GenerateStructured, generateStructured } from "./gemini";

const REANCHOR_TIMEOUT_MS = 10_000;
const NOT_FOUND: ScreenReanchorResponse = { found: false, actions: [] };

/**
 * "Show that again" when the desktop app couldn't find the focus region's text itself (S3
 * §2.3, decision 9): the fast model looks for the same content on a new screenshot.
 *
 * The model may only move the ink. Its answer is kept only if it has the same actions in the
 * same order with the same words, and passes the safety check; anything else is "not found".
 * The screenshot is only forwarded to the model (`store: false`), never kept.
 */
export async function reanchorScreen(
  request: ScreenReanchorRequest,
  signal?: AbortSignal,
  generate: GenerateStructured = generateStructured,
): Promise<ScreenReanchorResponse> {
  const answer = await generate({
    model: verifierModel(),
    system: SCREEN_REANCHOR_PROMPT.system,
    input: [
      { type: "text", text: renderReanchorInput(request) },
      { type: "image", base64: request.image.jpeg, mimeType: "image/jpeg" },
    ],
    schema: ScreenReanchorResponse,
    thinkingLevel: "low",
    maxOutputTokens: 1024,
    timeoutMs: REANCHOR_TIMEOUT_MS,
    ...(signal && { signal }),
  });
  if (!answer.found || !sameInk(request.previous, answer.actions)) return NOT_FOUND;
  const checked = checkScreenActions(answer.actions);
  if (checked.blocked.length > 0) {
    console.info(`[screen] safety check dropped re-placed ink (${checked.blocked.join(", ")})`);
    return NOT_FOUND;
  }
  return { found: true, actions: checked.actions };
}

/** The same actions, in order, with the same words (only boxes and points may differ). */
export function sameInk(
  previous: readonly ScreenAction[],
  moved: readonly ScreenAction[],
): boolean {
  const words = (action: ScreenAction): string[] => {
    switch (action.type) {
      case "circle_region":
      case "point_at":
        return action.label ? [action.label] : [];
      case "margin_note":
        return [action.text];
      case "write_step":
        return [action.latexOrText];
      default:
        return [];
    }
  };
  return (
    previous.length === moved.length &&
    previous.every((action, i) => {
      const other = moved[i];
      return (
        other !== undefined &&
        other.type === action.type &&
        JSON.stringify(words(other)) === JSON.stringify(words(action))
      );
    })
  );
}
