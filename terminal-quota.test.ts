import assert from "node:assert/strict";
import test from "node:test";
import { parseTerminalQuota } from "./terminal-quota.ts";

const size = { cols: 80, rows: 40 };

function chunk(seq: number, text: string | Buffer) {
  return { seq, dataBase64: Buffer.from(text).toString("base64") };
}

function frame(percentage = "91.14%", countdown = "Refreshes in 4h 22m") {
  return [
    "└ Models & Quota",
    "GEMINI MODELS",
    "  Weekly Limit Remaining",
    "  [██░] 97.04",
    "  Refreshes in 167h 22m",
    "  Five Hour Limit Remaining",
    `  [██░] ${percentage}`,
    `  ${countdown}`,
    "CLAUDE AND GPT MODELS",
    "  Weekly Limit Remaining",
    "  [███] 100.0",
    "  Quota available",
    "  Five Hour Limit Remaining",
    "  [███] 100.0",
    "  Quota available",
  ].join("\r\n");
}

test("uses the latest complete Gemini frame when the heading and UTF-8 bar span chunks", async () => {
  const latest = Buffer.from("\x1b[2J\x1b[H" + frame());
  const headingSplit = latest.indexOf("Models & Quota") + 9;
  const barSplit = latest.indexOf("██░") + 1;
  const chunks = [
    chunk(25, frame("100%", "Quota available")),
    chunk(36, latest.subarray(0, headingSplit)),
    chunk(37, latest.subarray(headingSplit, barSplit)),
    chunk(38, latest.subarray(barSplit)),
  ];

  assert.deepEqual(await parseTerminalQuota(size, chunks), {
    frameSeq: 36,
    weekly: { remainingPercent: 97.04, resetInMinutes: 10042 },
    fiveHour: { remainingPercent: 91.14, resetInMinutes: 262 },
  });
});

test("recognizes fully available Gemini quota without inventing a reset", async () => {
  assert.deepEqual((await parseTerminalQuota(size, [chunk(1, frame("100.0", "Quota available"))]))?.fiveHour, {
    remainingPercent: 100,
    resetInMinutes: null,
  });
});

test("does not borrow a missing Gemini quota from Claude and GPT", async () => {
  const missing = frame().replace(/  \[██░\] 91\.14%\r\n  Refreshes in 4h 22m\r\n/, "");
  assert.equal(await parseTerminalQuota(size, [chunk(1, missing)]), null);
});

test("applies cursor-addressed updates within the same full frame", async () => {
  const output = [
    chunk(37, "\x1b[2J\x1b[H" + frame()),
    chunk(38, "\x1b[7;1H\x1b[2K  [██░] 88.25%"),
    chunk(39, "\x1b[8;1H\x1b[2K  Refreshes in 4h 19m"),
  ];
  assert.deepEqual((await parseTerminalQuota(size, output))?.fiveHour, {
    remainingPercent: 88.25,
    resetInMinutes: 259,
  });
});

test("reads a complete narrow frame and rejects a visibly incomplete percentage", async () => {
  const narrow = { cols: 38, rows: 18 };
  const wrappedBar = frame().replace("[██░] 91.14%", "[████████████████████████████████████] 91.14%");
  assert.equal((await parseTerminalQuota(narrow, [chunk(1, wrappedBar)]))?.fiveHour.remainingPercent, 91.14);
  assert.equal(await parseTerminalQuota(narrow, [chunk(1, frame("91."))]), null);
});
