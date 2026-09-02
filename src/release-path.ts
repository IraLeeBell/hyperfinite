const MAX_USTAR_NAME_BYTES = 100;
const MAX_USTAR_PREFIX_BYTES = 155;
const RELEASE_ARCHIVE_PREFIX = "payload";

export const MAX_RELEASE_PATH_LENGTH = 224;

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      if (index + 1 >= value.length) return false;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function assertCanonicalRelativePath(
  value: string,
  maximumLength: number,
  subject: string
): void {
  if (
    typeof value !== "string" ||
    [...value].length < 1 ||
    [...value].length > maximumLength ||
    !isWellFormedUnicode(value) ||
    value.normalize("NFC") !== value ||
    value.startsWith("/") ||
    value.includes("\\") ||
    /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value)
  ) {
    throw new TypeError(`${subject} is not a canonical relative path`);
  }
  if (
    value
      .split("/")
      .some(
        (segment) =>
          segment.length === 0 ||
          segment === "." ||
          segment === ".." ||
          segment === ".git"
      )
  ) {
    throw new TypeError(`${subject} contains a denied path segment`);
  }
}

export function splitCanonicalUstarPath(
  archivePath: string
): { readonly name: string; readonly prefix: string } {
  assertCanonicalRelativePath(
    archivePath,
    MAX_RELEASE_PATH_LENGTH + RELEASE_ARCHIVE_PREFIX.length + 1,
    "release archive path"
  );
  if (Buffer.byteLength(archivePath, "utf8") <= MAX_USTAR_NAME_BYTES) {
    return { name: archivePath, prefix: "" };
  }
  for (
    let index = archivePath.lastIndexOf("/");
    index > 0;
    index = archivePath.lastIndexOf("/", index - 1)
  ) {
    const prefix = archivePath.slice(0, index);
    const name = archivePath.slice(index + 1);
    if (
      Buffer.byteLength(prefix, "utf8") <= MAX_USTAR_PREFIX_BYTES &&
      Buffer.byteLength(name, "utf8") <= MAX_USTAR_NAME_BYTES
    ) {
      return { name, prefix };
    }
  }
  throw new TypeError(
    `release archive path cannot be represented in canonical ustar: ${archivePath}`
  );
}

export function assertReleasePath(
  value: string,
  subject = "release path"
): void {
  assertCanonicalRelativePath(value, MAX_RELEASE_PATH_LENGTH, subject);
  try {
    splitCanonicalUstarPath(`${RELEASE_ARCHIVE_PREFIX}/${value}`);
  } catch {
    throw new TypeError(
      `${subject} cannot be represented in canonical ustar UTF-8 fields`
    );
  }
}

export function isReleasePath(value: string): boolean {
  try {
    assertReleasePath(value);
    return true;
  } catch {
    return false;
  }
}

export function releaseArchivePath(value: string): string {
  assertReleasePath(value);
  return `${RELEASE_ARCHIVE_PREFIX}/${value}`;
}
