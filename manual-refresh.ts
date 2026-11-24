import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { parseTerminalQuota, type GeminiQuotaFrame } from "./terminal-quota.ts";

type Terminals = Pick<BbPluginApi["sdk"]["terminals"], "create" | "output" | "input" | "close">;

export async function readAntigravityQuota(
  terminals: Terminals,
  hostId: string,
  cwd: string,
  executablePath = join(homedir(), ".local", "bin", "agy"),
): Promise<GeminiQuotaFrame> {
  const terminal = await terminals.create({
    scope: { kind: "host_path", hostId, cwd },
    title: "Обновление квот Gemini",
    cols: 120,
    rows: 45,
    start: { mode: "argv", argv: [executablePath] },
  });
  const terminalId = terminal.id;
  const signal = AbortSignal.timeout(24_000);

  try {
    let commandSent = false;
    let panelTime: number | undefined;
    while (!signal.aborted) {
      const output = await terminals.output({ terminalId, tailBytes: 64_000, signal });
      if (output.status === "exited" || output.status === "disconnected") {
        throw new Error("Antigravity exited before returning quotas.");
      }

      if (!commandSent) {
        const text = Buffer.concat(output.chunks.map(({ dataBase64 }) => Buffer.from(dataBase64, "base64")))
          .toString("utf8").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
        if (text.includes("Antigravity CLI") && text.includes("? for shortcuts")) {
          await terminals.input({ terminalId, dataBase64: Buffer.from("/usage\r").toString("base64") });
          commandSent = true;
        }
      } else {
        const frame = await parseTerminalQuota(terminal, output.chunks);
        if (frame) {
          panelTime ??= Date.now();
          // Antigravity paints the panel first, then applies the quota response.
          if (Date.now() - panelTime >= 1_500) return frame;
        }
      }
      await delay(250, undefined, { signal });
    }
    throw signal.reason;
  } finally {
    await terminals.close({ terminalId, mode: "force" }).catch(() => undefined);
  }
}
