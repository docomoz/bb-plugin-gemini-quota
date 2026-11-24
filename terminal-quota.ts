import * as xterm from "@xterm/headless";

export interface QuotaWindow {
  remainingPercent: number;
  resetInMinutes: number | null;
}

export interface GeminiQuotaFrame {
  frameSeq: number;
  fiveHour: QuotaWindow;
  weekly: QuotaWindow;
}

interface TerminalSize {
  cols: number;
  rows: number;
}

interface OutputChunk {
  seq: number;
  dataBase64: string;
}

type GeminiQuota = Omit<GeminiQuotaFrame, "frameSeq">;

const maxScrollbackBytes = 96 * 1024;
const panelHeading = "Models & Quota";
const terminalEscapes = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]/g;
const modelGroup = /^[ \t]*[A-Z][A-Z0-9 &/-]+ MODELS[ \t]*$/m;
const weeklyHeading = "Weekly Limit Remaining";
const fiveHourHeading = "Five Hour Limit Remaining";

function readWindow(text: string): QuotaWindow | null {
  const meter = /\[[█░\s]+\]\s*(\d{1,3}(?:[.,]\d{1,2})?)[ \t]*%?\s*(?:Refreshes in\s+((?:\d+\s*[dhm]\s*)+)|Quota available)/u;
  const match = meter.exec(text);
  if (!match) return null;

  const number = Number(match[1]?.replace(",", "."));
  if (!Number.isFinite(number) || number < 0 || number > 100) return null;
  if (!match[2]) return { remainingPercent: number, resetInMinutes: null };

  let resetInMinutes = 0;
  for (const part of match[2].matchAll(/(\d+)\s*([dhm])/g)) {
    const factor = part[2] === "d" ? 1440 : part[2] === "h" ? 60 : 1;
    resetInMinutes += Number(part[1]) * factor;
  }
  if (!Number.isSafeInteger(resetInMinutes) || resetInMinutes > 8 * 1440) return null;
  return { remainingPercent: number, resetInMinutes };
}

function readGeminiGroup(screen: string): GeminiQuota | null {
  const start = /^[ \t]*GEMINI MODELS[ \t]*$/m.exec(screen);
  if (!start) return null;

  const afterHeading = screen.slice(start.index + start[0].length);
  const nextGroup = modelGroup.exec(afterHeading);
  const gemini = afterHeading.slice(0, nextGroup?.index ?? afterHeading.length);
  const weeklyIndex = gemini.indexOf(weeklyHeading);
  const fiveHourIndex = gemini.indexOf(fiveHourHeading);
  if (weeklyIndex < 0 || fiveHourIndex < 0) return null;

  const weekly = readWindow(gemini.slice(weeklyIndex + weeklyHeading.length, fiveHourIndex > weeklyIndex ? fiveHourIndex : undefined));
  const fiveHour = readWindow(gemini.slice(fiveHourIndex + fiveHourHeading.length, weeklyIndex > fiveHourIndex ? weeklyIndex : undefined));
  return weekly && fiveHour ? { weekly, fiveHour } : null;
}

async function readRenderedQuota(size: TerminalSize, text: string): Promise<GeminiQuota | null> {
  if (size.cols < 30 || size.cols > 300 || size.rows < 16 || size.rows > 150) return null;

  const module = xterm as typeof xterm & { default?: typeof xterm };
  const Terminal = module.Terminal ?? module.default?.Terminal;
  if (!Terminal) return null;
  const terminal = new Terminal({ ...size, allowProposedApi: true, scrollback: 0 });
  try {
    await new Promise<void>((resolve) => terminal.write(text, resolve));
    const viewport = terminal.buffer.active;
    const lines = Array.from({ length: size.rows }, (_, row) =>
      viewport.getLine(viewport.baseY + row),
    ).reduce<string[]>((screen, line) => {
      const text = line?.translateToString(true) ?? "";
      if (line?.isWrapped && screen.length > 0) screen[screen.length - 1] += text;
      else screen.push(text);
      return screen;
    }, []);
    const heading = lines.map((line) => line.includes(panelHeading)).lastIndexOf(true);
    return heading >= 0 ? readGeminiGroup(lines.slice(heading + 1).join("\n")) : null;
  } finally {
    terminal.dispose();
  }
}

export async function parseTerminalQuota(
  size: TerminalSize,
  chunks: readonly OutputChunk[],
): Promise<GeminiQuotaFrame | null> {
  // BB returns ordered output chunks. Read only a bounded tail of this terminal.
  const recent: { seq: number; data: Buffer }[] = [];
  let bytes = 0;
  for (let index = chunks.length - 1; index >= 0 && bytes < maxScrollbackBytes; index -= 1) {
    const chunk = chunks[index];
    const data = Buffer.from(chunk.dataBase64, "base64").subarray(-(maxScrollbackBytes - bytes));
    bytes += data.length;
    recent.push({ seq: chunk.seq, data });
  }
  recent.reverse();

  const text = Buffer.concat(recent.map(({ data }) => data), bytes).toString("utf8");
  const headers = [...text.matchAll(/Models & Quota/g)];
  const rendered = headers.length > 0 ? await readRenderedQuota(size, text) : null;

  for (let index = headers.length - 1; index >= 0; index -= 1) {
    const start = headers[index]?.index ?? 0;
    const end = headers[index + 1]?.index ?? text.length;
    const body = text.slice(start + panelHeading.length, end).replace(terminalEscapes, "").replaceAll("\r", "\n");
    const quota = readGeminiGroup(body);
    if (!quota) continue;

    let frameOffset = Buffer.byteLength(text.slice(0, start));
    const source = recent.find(({ data }) => {
      if (frameOffset < data.length) return true;
      frameOffset -= data.length;
      return false;
    });
    if (!source) return null;
    const latestQuota = index === headers.length - 1 ? rendered ?? quota : quota;
    return { frameSeq: source.seq, ...latestQuota };
  }

  return null;
}
