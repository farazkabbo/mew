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
