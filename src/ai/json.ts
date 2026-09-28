/**
 * Balanced bracket scanning is adapted from madoka-chann/Bilibili-AI-Favorites-Organizer
 * src/utils/json-extract.ts (MIT), with array support and string-safe comma repair.
 */
export function extractJsonValue(raw: string): unknown {
  for (let start = 0; start < raw.length; start += 1) {
    const opening = raw[start];
    if (opening !== '[' && opening !== '{') continue;

    const end = findBalancedEnd(raw, start);
    if (end < 0) continue;

    const candidate = raw.slice(start, end + 1);
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      try {
        return JSON.parse(removeTrailingCommas(candidate)) as unknown;
      } catch {
        // There may be explanatory text or an invalid example before the result.
      }
    }
  }

  throw new SyntaxError('AI response did not contain valid JSON');
}

function findBalancedEnd(text: string, start: number): number {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === '{') {
      stack.push('}');
    } else if (char === '[') {
      stack.push(']');
    } else if (char === '}' || char === ']') {
      if (stack.pop() !== char) return -1;
      if (stack.length === 0) return index;
    }
  }

  return -1;
}

/** Removes commas immediately before a closing bracket, without touching strings. */
function removeTrailingCommas(value: string): string {
  let output = '';
  let inString = false;
  let escaped = false;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (inString) {
      output += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') {
      inString = true;
      output += char;
    } else if (char === ',') {
      let next = index + 1;
      while (next < value.length && /\s/.test(value[next])) next += 1;
      if (value[next] !== ']' && value[next] !== '}') output += char;
    } else {
      output += char;
    }
  }

  return output;
}
