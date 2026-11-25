import {
  RecipeModelResponse,
  RecipeRequest,
  renderRecipeInput,
  SCREEN_RECIPE_PROMPT,
  unsafeReasons,
} from "@mew/shared";
import { NextResponse } from "next/server";

import { requireDevice } from "@/server/device-auth";
import { geminiEnv, screenModel } from "@/server/env";
import { generateStructured } from "@/server/gemini";
import { handle, readJson } from "@/server/http";
import { HttpError } from "@/server/http-error";
import { askerOf, remainingHeaders, startQuestion } from "@/server/question-gate";
import { enforceRateLimit, RATE_RULES } from "@/server/rate-limit";
import { unavailableMessage } from "@/server/tutor";

/** The JSON body: up to 12,000 characters of page text, a title and an address. */
const MAX_BODY_BYTES = 40_000;

/**
 * DO IT's `save_recipe` fallback (docs/CURSOR_MODES.md), from the desktop app (device token):
 * the text of a page with no recipe markup, structured into a recipe. One of the learner's
 * questions. Nothing is stored here; the desktop saves the recipe through the clips route.
 */
export const POST = handle(async (request: Request) => {
  const device = await requireDevice(request);
  enforceRateLimit(device.userId, {
    screenRecipe: RATE_RULES.screenRecipe,
    screenRecipeDaily: RATE_RULES.screenRecipeDaily,
  });
  const body = await readJson(request, RecipeRequest, MAX_BODY_BYTES);
  geminiEnv();
  const question = await startQuestion(askerOf(request, device.userId));
  let made: RecipeModelResponse;
  try {
    made = await question.run(() =>
      generateStructured({
        model: screenModel(),
        purpose: "screen-recipe",
        system: SCREEN_RECIPE_PROMPT.system,
        input: [{ type: "text" as const, text: renderRecipeInput(body) }],
        schema: RecipeModelResponse,
        thinkingLevel: "low" as const,
        maxOutputTokens: 4096,
        timeoutMs: 25_000,
        signal: request.signal,
      }),
    );
  } catch (error) {
    await question.refund();
    throw new HttpError(503, unavailableMessage(error));
  }
  const texts = [made.title, made.originalTitle ?? "", ...made.ingredients, ...made.steps];
  if (!made.found || texts.some((t) => unsafeReasons(t).length > 0)) {
    // Nothing found (or nothing safe to keep) costs nothing.
    await question.refund();
    return NextResponse.json({ ...made, found: false, ingredients: [], steps: [] });
  }
  await question.finish();
  return NextResponse.json(made, {
    headers: { "Cache-Control": "no-store", ...remainingHeaders(question) },
  });
});
