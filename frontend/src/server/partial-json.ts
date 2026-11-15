/**
 * Returns the value of a string field once its closing quote has arrived in a partially streamed
 * JSON object, or null while it is still incomplete. Used to start speaking the tutor's reply
 * before the rest of the response (board actions) has been generated.
 *
 * Assumes the field is the first occurrence of `"<field>":` in the text, which holds when the
 * schema lists it first (as TutorResponse does with `speech`).
 */
export function completedStringField(partial: string, field: string): string | null {
  const key = new RegExp(`"${escapeRegExp(field)}"\\s*:\\s*"`).exec(partial);
  if (!key) return null;
  const start = key.index + key[0].length - 1; // the opening quote
  for (let i = start + 1; i < partial.length; i++) {
    const c = partial[i];
    if (c === "\\") {
      i++; // skip the escaped character
    } else if (c === '"') {
      try {
        return JSON.parse(partial.slice(start, i + 1)) as string;
      } catch {
        return null;
      }
    }
  }
  return null;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The items of an array field that are complete so far in a partially streamed JSON object
 * (each parsed), in order. Used to play a circle-ask answer's steps as they're written.
 *
 * Assumes, like `completedStringField`, that the first `"<field>": [` is the field itself.
 */
export function completedArrayItems(partial: string, field: string): unknown[] {
  const key = new RegExp(`"${escapeRegExp(field)}"\\s*:\\s*\\[`).exec(partial);
  if (!key) return [];
  const items: unknown[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  for (let i = key.index + key[0].length; i < partial.length; i++) {
    const c = partial[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
    } else if (c === "{" || c === "[") {
      if (depth === 0) start = i;
      depth++;
    } else if (c === "}" || c === "]") {
      if (depth === 0) break; // the array itself ended
      depth--;
      if (depth === 0 && start >= 0) {
        try {
          items.push(JSON.parse(partial.slice(start, i + 1)));
        } catch {
          return items;
        }
        start = -1;
      }
    }
  }
  return items;
}

/**
 * The value of a string field as far as it has arrived in a partially streamed JSON object,
 * decoded, and whether its closing quote has come. Null until the field starts. Used to type a
 * passage into the student's document while the model is still writing it.
 *
 * An escape or a surrogate pair cut off by the end of the text is held back until it's whole,
 * so what's returned only ever grows. Assumes, like `completedStringField`, that the first
 * `"<field>": "` is the field itself.
 */
export function partialStringField(
  partial: string,
  field: string,
): { value: string; done: boolean } | null {
  const key = new RegExp(`"${escapeRegExp(field)}"\\s*:\\s*"`).exec(partial);
  if (!key) return null;
  const SIMPLE: Record<string, string> = {
    '"': '"',
    "\\": "\\",
    "/": "/",
    b: "\b",
    f: "\f",
    n: "\n",
    r: "\r",
    t: "\t",
  };
  let value = "";
  let i = key.index + key[0].length;
  while (i < partial.length) {
    const c = partial[i]!;
    if (c === '"') return { value, done: true };
    if (c !== "\\") {
      value += c;
      i++;
      continue;
    }
    const next = partial[i + 1];
    if (next === undefined) break; // the escape isn't whole yet
    if (next !== "u") {
      value += SIMPLE[next] ?? next;
      i += 2;
      continue;
    }
    const hex = partial.slice(i + 2, i + 6);
    if (hex.length < 4) break;
    const unit = Number.parseInt(hex, 16);
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
      i += 6; // not a real escape: dropped
      continue;
    }
    value += String.fromCharCode(unit);
    i += 6;
  }
  // Half of a surrogate pair waits for its other half.
  const last = value.charCodeAt(value.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) value = value.slice(0, -1);
  return { value, done: false };
}
