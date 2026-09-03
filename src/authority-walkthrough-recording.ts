import type { AuthorityWalkthroughResult } from "./authority-walkthrough.js";
import { renderAuthorityBoundaryRecordingFrames } from "./authority-walkthrough.js";

const WIDTH = 640;
const SCALE = 2;
const GLYPH_WIDTH = 5;
const GLYPH_HEIGHT = 7;
const CHARACTER_ADVANCE = 6 * SCALE;
const LINE_HEIGHT = 9 * SCALE;
const FRAME_PADDING = 4 * SCALE;
const ORDINARY_FRAME_DELAY = 40;
const FINAL_FRAME_DELAY = 150;

export const AUTHORITY_WALKTHROUGH_RECORDING_DURATION_MS =
  (8 * ORDINARY_FRAME_DELAY + FINAL_FRAME_DELAY) * 10;

const glyphs: Readonly<Record<string, readonly string[]>> = {
  " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"],
  "?": ["01110", "10001", "00001", "00010", "00100", "00000", "00100"],
  "$": ["00100", "01111", "10100", "01110", "00101", "11110", "00100"],
  "#": ["01010", "11111", "01010", "01010", "11111", "01010", "01010"],
  ":": ["00000", "00100", "00100", "00000", "00100", "00100", "00000"],
  ".": ["00000", "00000", "00000", "00000", "00000", "00110", "00110"],
  "-": ["00000", "00000", "00000", "11111", "00000", "00000", "00000"],
  "_": ["00000", "00000", "00000", "00000", "00000", "00000", "11111"],
  "/": ["00001", "00010", "00100", "01000", "10000", "00000", "00000"],
  "=": ["00000", "11111", "00000", "11111", "00000", "00000", "00000"],
  ";": ["00000", "00110", "00110", "00000", "00110", "00100", "01000"],
  "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  "3": ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  "5": ["11111", "10000", "10000", "11110", "00001", "00001", "11110"],
  "6": ["01110", "10000", "10000", "11110", "10001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00001", "01110"],
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  B: ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
  C: ["01110", "10001", "10000", "10000", "10000", "10001", "01110"],
  D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  F: ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
  G: ["01110", "10001", "10000", "10111", "10001", "10001", "01110"],
  H: ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
  I: ["01110", "00100", "00100", "00100", "00100", "00100", "01110"],
  J: ["00111", "00010", "00010", "00010", "10010", "10010", "01100"],
  K: ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  M: ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
  N: ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  Q: ["01110", "10001", "10001", "10001", "10101", "10010", "01101"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  U: ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
  V: ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
  W: ["10001", "10001", "10001", "10101", "10101", "10101", "01010"],
  X: ["10001", "10001", "01010", "00100", "01010", "10001", "10001"],
  Y: ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
  Z: ["11111", "00001", "00010", "00100", "01000", "10000", "11111"]
};

function littleEndian(value: number): readonly number[] {
  return [value & 0xff, (value >> 8) & 0xff];
}

function renderLines(
  lines: readonly string[],
  foreground: readonly number[]
): Uint8Array {
  const height = lines.length * LINE_HEIGHT + FRAME_PADDING * 2;
  const pixels = new Uint8Array(WIDTH * height);
  lines.forEach((rawLine, lineIndex) => {
    const line = rawLine.toUpperCase();
    if (line.length * CHARACTER_ADVANCE + FRAME_PADDING * 2 > WIDTH) {
      throw new TypeError(`recording line exceeds ${WIDTH} pixels: ${rawLine}`);
    }
    const color = foreground[lineIndex] ?? 2;
    [...line].forEach((character, characterIndex) => {
      const glyph = glyphs[character] ?? glyphs["?"];
      if (glyph === undefined) throw new TypeError("fallback glyph is missing");
      glyph.forEach((row, rowIndex) => {
        [...row].forEach((pixel, columnIndex) => {
          if (pixel !== "1") return;
          const startX =
            FRAME_PADDING + characterIndex * CHARACTER_ADVANCE + columnIndex * SCALE;
          const startY =
            FRAME_PADDING + lineIndex * LINE_HEIGHT + rowIndex * SCALE;
          for (let y = 0; y < SCALE; y += 1) {
            for (let x = 0; x < SCALE; x += 1) {
              pixels[(startY + y) * WIDTH + startX + x] = color;
            }
          }
        });
      });
    });
  });
  return pixels;
}

function literalLzw(pixels: Uint8Array): Uint8Array {
  const clearCode = 4;
  const endCode = 5;
  const codes: number[] = [];
  for (let index = 0; index < pixels.length; index += 2) {
    codes.push(clearCode, pixels[index] ?? 0);
    if (index + 1 < pixels.length) codes.push(pixels[index + 1] ?? 0);
  }
  codes.push(endCode);
  const bytes: number[] = [];
  let packed = 0;
  let bitCount = 0;
  for (const code of codes) {
    packed |= code << bitCount;
    bitCount += 3;
    while (bitCount >= 8) {
      bytes.push(packed & 0xff);
      packed >>= 8;
      bitCount -= 8;
    }
  }
  if (bitCount > 0) bytes.push(packed & 0xff);
  return Uint8Array.from(bytes);
}

function imageData(pixels: Uint8Array): readonly number[] {
  const compressed = literalLzw(pixels);
  const blocks: number[] = [2];
  for (let offset = 0; offset < compressed.length; offset += 255) {
    const block = compressed.subarray(offset, offset + 255);
    blocks.push(block.length, ...block);
  }
  blocks.push(0);
  return blocks;
}

function frameColor(line: string, index: number): number {
  if (line.includes("REFUSED")) return 3;
  if (
    index === 0 &&
    (line.includes("APPLIED") ||
      line.includes("HUMAN_REVIEW") ||
      line.startsWith("HYPERFINITE"))
  ) {
    return 1;
  }
  return 2;
}

export function renderAuthorityBoundaryGif(
  result: AuthorityWalkthroughResult
): Buffer {
  const groups = renderAuthorityBoundaryRecordingFrames(result);
  const heights = groups.map(
    (lines) => lines.length * LINE_HEIGHT + FRAME_PADDING * 2
  );
  const height = heights.reduce((sum, current) => sum + current, 0);
  if (height > 480) {
    throw new TypeError("recording exceeds the bounded terminal height");
  }
  const bytes: number[] = [
    ...Buffer.from("GIF89a", "ascii"),
    ...littleEndian(WIDTH),
    ...littleEndian(height),
    0xf1,
    0,
    0,
    13,
    17,
    23,
    63,
    185,
    80,
    230,
    237,
    243,
    248,
    81,
    73
  ];
  let top = 0;
  groups.forEach((lines, groupIndex) => {
    const frameHeight = heights[groupIndex];
    if (frameHeight === undefined) {
      throw new TypeError("recording frame height is missing");
    }
    const colors = lines.map((line, lineIndex) => frameColor(line, lineIndex));
    const delay =
      groupIndex === groups.length - 1
        ? FINAL_FRAME_DELAY
        : ORDINARY_FRAME_DELAY;
    bytes.push(
      0x21,
      0xf9,
      0x04,
      0x04,
      ...littleEndian(delay),
      0x00,
      0x00,
      0x2c,
      ...littleEndian(0),
      ...littleEndian(top),
      ...littleEndian(WIDTH),
      ...littleEndian(frameHeight),
      0x00,
      ...imageData(renderLines(lines, colors))
    );
    top += frameHeight;
  });
  bytes.push(0x3b);
  return Buffer.from(bytes);
}
