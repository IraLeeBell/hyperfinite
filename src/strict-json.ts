function skipWhitespace(source: string, start: number): number {
  let index = start;
  while (
    source[index] === " " ||
    source[index] === "\n" ||
    source[index] === "\r" ||
    source[index] === "\t"
  ) {
    index += 1;
  }
  return index;
}

function scanString(source: string, start: number): number {
  let index = start + 1;
  while (index < source.length) {
    const character = source[index];
    if (character === "\\") {
      index += 2;
      continue;
    }
    if (character === '"') return index + 1;
    index += 1;
  }
  throw new SyntaxError("unterminated JSON string");
}

function decodedString(source: string, start: number, end: number): string {
  return JSON.parse(source.slice(start, end)) as string;
}

function scanScalar(source: string, start: number): number {
  let index = start;
  while (
    index < source.length &&
    source[index] !== "," &&
    source[index] !== "]" &&
    source[index] !== "}" &&
    source[index] !== " " &&
    source[index] !== "\n" &&
    source[index] !== "\r" &&
    source[index] !== "\t"
  ) {
    index += 1;
  }
  return index;
}

function scanValue(source: string, start: number, path: string): number {
  let index = skipWhitespace(source, start);
  const character = source[index];
  if (character === '"') return scanString(source, index);
  if (character === "[") {
    index = skipWhitespace(source, index + 1);
    let item = 0;
    if (source[index] === "]") return index + 1;
    while (index < source.length) {
      index = scanValue(source, index, `${path}/${item}`);
      index = skipWhitespace(source, index);
      if (source[index] === "]") return index + 1;
      if (source[index] !== ",") {
        throw new SyntaxError(`invalid JSON array at ${path}`);
      }
      index = skipWhitespace(source, index + 1);
      item += 1;
    }
    throw new SyntaxError(`unterminated JSON array at ${path}`);
  }
  if (character === "{") {
    index = skipWhitespace(source, index + 1);
    const keys = new Set<string>();
    if (source[index] === "}") return index + 1;
    while (index < source.length) {
      if (source[index] !== '"') {
        throw new SyntaxError(`invalid JSON object key at ${path}`);
      }
      const keyStart = index;
      const keyEnd = scanString(source, keyStart);
      const key = decodedString(source, keyStart, keyEnd);
      if (keys.has(key)) {
        throw new SyntaxError(`duplicate JSON object key ${JSON.stringify(key)} at ${path}`);
      }
      keys.add(key);
      index = skipWhitespace(source, keyEnd);
      if (source[index] !== ":") {
        throw new SyntaxError(`invalid JSON object separator at ${path}/${key}`);
      }
      index = scanValue(source, index + 1, `${path}/${key}`);
      index = skipWhitespace(source, index);
      if (source[index] === "}") return index + 1;
      if (source[index] !== ",") {
        throw new SyntaxError(`invalid JSON object at ${path}`);
      }
      index = skipWhitespace(source, index + 1);
    }
    throw new SyntaxError(`unterminated JSON object at ${path}`);
  }
  return scanScalar(source, index);
}

export function parseStrictJson(source: string): unknown {
  const value = JSON.parse(source) as unknown;
  const end = skipWhitespace(source, scanValue(source, 0, ""));
  if (end !== source.length) {
    throw new SyntaxError("unexpected data after JSON document");
  }
  return value;
}
