import { posix, win32 } from "node:path";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { readAntigravityQuota } from "./manual-refresh.js";
import { parseTerminalQuota } from "./terminal-quota.js";

const listResources = "provider-usage.v1.listResources";
const getResource = "provider-usage.v1.getResource";
const executablePathSchema = z.string().refine((path) => !path.includes("\0") && (posix.isAbsolute(path) || win32.isAbsolute(path)), {
  message: "Enter an absolute Antigravity executable path on the terminal host.",
});
const terminalIdSchema = z.string().regex(/^term_[a-z0-9]{10}$/);
const scopeSchema = z.object({
  kind: z.literal("host"),
  hostId: z.string(),
  hostName: z.string(),
});
const windowSchema = z.object({
  id: z.string(),
  kind: z.enum(["five-hour", "weekly"]),
  label: z.string(),
  usedPercent: z.number().min(0).max(100),
  resetsAt: z.iso.datetime().nullable(),
  model: z.null(),
  cost: z.null(),
});
const snapshotSchema = z.object({
  scope: scopeSchema,
  workingDirectory: z.string().optional(),
  agyPath: z.string().optional(),
  frameSeq: z.number().int().nonnegative(),
  observedAt: z.number().int().positive(),
  windows: z.tuple([windowSchema, windowSchema]),
});
type Snapshot = z.infer<typeof snapshotSchema>;

const usageContract = defineRpcContract({
  [listResources]: {
    input: z.object({}),
    output: z.object({ resources: z.array(z.object({
      id: z.string(),
      providerId: z.string(),
      accountKey: z.null(),
      label: z.string(),
      scope: scopeSchema,
    })) }),
  },
  [getResource]: {
    input: z.object({ resourceId: z.string(), refresh: z.boolean() }),
    output: z.object({
      accountKey: z.null(),
      observedAt: z.number().int().nonnegative().nullable(),
      usage: z.discriminatedUnion("status", [
        z.object({ status: z.literal("ok"), accountEmail: z.null(), planLabel: z.string(), windows: z.array(windowSchema) }),
        z.object({ status: z.literal("error"), accountEmail: z.null(), planLabel: z.null(), message: z.string() }),
      ]),
    }),
  },
});

function makeWindow(
  kind: Snapshot["windows"][number]["kind"],
  observedAt: number,
  { remainingPercent, resetInMinutes }: { remainingPercent: number; resetInMinutes: number | null },
): Snapshot["windows"][number] {
  return {
    id: kind,
    kind,
    label: kind === "five-hour" ? "5h" : "7d",
    usedPercent: Math.round((100 - remainingPercent) * 100) / 100,
    resetsAt: resetInMinutes === null ? null : new Date(observedAt + resetInMinutes * 60_000).toISOString(),
    model: null,
    cost: null,
  };
}

export default function geminiQuota(bb: BbPluginApi) {
  const settings = bb.settings.define({
    terminalId: {
      type: "string",
      label: "Antigravity terminal",
      description: "ID of a dedicated BB terminal on the host where Antigravity is installed.",
      default: "",
      experimental_schema: z.union([z.literal(""), terminalIdSchema]),
    },
    agyPath: {
      type: "string",
      label: "Antigravity executable path",
      description: "Absolute path on the terminal host. Leave blank if AGY is in .local/bin under the BB server account’s home directory on that host.",
      default: "",
      experimental_schema: z.union([z.literal(""), executablePathSchema]),
    },
  });
  const inFlight = new Map<string, Promise<Snapshot | undefined>>();
  const manualInFlight = new Map<string, Promise<Snapshot>>();

  async function load(terminalId: string, source = "snapshot") {
    return snapshotSchema.safeParse(await bb.storage.kv.get(`${source}:${terminalId}`)).data;
  }

  async function latest(terminalId: string) {
    const [screen, manual] = await Promise.all([load(terminalId), load(terminalId, "manual")]);
    return manual && (!screen || manual.observedAt >= screen.observedAt) ? manual : screen;
  }

  async function getScope(terminalId: string) {
    const terminal = await bb.sdk.terminals.get({ terminalId, signal: AbortSignal.timeout(5_000) });
    const host = (await bb.sdk.hosts.list()).find(({ id }) => id === terminal.hostId);
    return { terminal, scope: { kind: "host" as const, hostId: terminal.hostId, hostName: host?.name ?? terminal.hostId } };
  }

  async function capture(terminalId: string) {
    const previous = await load(terminalId);
    let operation = "get terminal";
    try {
      const { terminal, scope } = await getScope(terminalId);
      if (terminal.status !== "running") return previous;
      operation = "read terminal output";
      const output = await bb.sdk.terminals.output({ terminalId, tailBytes: 64_000, signal: AbortSignal.timeout(5_000) });
      operation = "parse quota screen";
      const frame = await parseTerminalQuota(terminal, output.chunks);
      if (!frame) return previous;

      const observedAt = Date.now();
      const next: Snapshot = {
        scope,
        workingDirectory: terminal.initialCwd,
        frameSeq: frame.frameSeq,
        observedAt,
        windows: [makeWindow("five-hour", observedAt, frame.fiveHour), makeWindow("weekly", observedAt, frame.weekly)],
      };
      if (previous?.frameSeq === next.frameSeq && previous.windows.every((window, index) => window.usedPercent === next.windows[index].usedPercent)) {
        return previous;
      }
      operation = "save quota snapshot";
      await bb.storage.kv.set(`snapshot:${terminalId}`, snapshotSchema.parse(next));
      return next;
    } catch (error) {
      const detail = error instanceof Error ? error.name : "Unknown error";
      bb.log.warn(`Could not ${operation}: ${detail}`);
      return previous;
    }
  }

  function refresh(terminalId: string) {
    const running = inFlight.get(terminalId);
    if (running) return running;
    const result = capture(terminalId).finally(() => inFlight.delete(terminalId));
    inFlight.set(terminalId, result);
    return result;
  }

  async function requestNewSnapshot(terminalId: string, agyPath: string) {
    const previous = await load(terminalId, "manual");
    if (previous && previous.agyPath === agyPath && Date.now() - previous.observedAt < 15_000) return previous;

    const source = await getScope(terminalId).catch(() => undefined);
    const saved = source ? undefined : await latest(terminalId);
    const scope = source?.scope ?? saved?.scope;
    const workingDirectory = source?.terminal.initialCwd ?? saved?.workingDirectory;
    if (!scope || !workingDirectory) throw new Error("Antigravity workspace unavailable.");

    const frame = await readAntigravityQuota(bb.sdk.terminals, scope.hostId, workingDirectory, agyPath || undefined);
    const observedAt = Date.now();
    const next = snapshotSchema.parse({
      scope,
      workingDirectory,
      agyPath,
      frameSeq: frame.frameSeq,
      observedAt,
      windows: [makeWindow("five-hour", observedAt, frame.fiveHour), makeWindow("weekly", observedAt, frame.weekly)],
    });
    await bb.storage.kv.set(`manual:${terminalId}`, next);
    return next;
  }

  function refreshManually(terminalId: string, agyPath: string) {
    const key = `${terminalId}:${agyPath}`;
    const running = manualInFlight.get(key);
    if (running) return running;
    const result = requestNewSnapshot(terminalId, agyPath).finally(() => manualInFlight.delete(key));
    manualInFlight.set(key, result);
    return result;
  }

  function resourceId(terminalId: string) {
    return `gemini-quota:${terminalId}`;
  }

  bb.background.schedule("read-local-quota", "* * * * *", async () => {
    const { terminalId } = await settings.get();
    if (terminalId) await refresh(terminalId);
  });

  bb.rpc.register(usageContract, {
    async [listResources]() {
      const { terminalId } = await settings.get();
      if (!terminalId) return { resources: [] };
      const saved = await latest(terminalId);
      const scope = saved?.scope ?? await getScope(terminalId).then((item) => item.scope).catch(() => undefined);
      if (!scope) return { resources: [] };
      return { resources: [{ id: resourceId(terminalId), providerId: "Gemini", label: "Gemini", accountKey: null, scope }] };
    },
    async [getResource](request) {
      const { terminalId, agyPath } = await settings.get();
      if (!terminalId || request.resourceId !== resourceId(terminalId)) throw new Error("Gemini quota resource was not found.");
      let refreshFailed = false;
      const updated = request.refresh ? await refreshManually(terminalId, agyPath).catch((error: unknown) => {
        refreshFailed = true;
        const detail = error instanceof Error ? error.name : "Unknown error";
        bb.log.warn(`Could not refresh Antigravity quotas: ${detail}`);
        return undefined;
      }) : undefined;
      const saved = updated ?? await latest(terminalId) ?? await refresh(terminalId);
      const now = Date.now();
      const windows = saved?.windows.filter(({ resetsAt }) => resetsAt === null || Date.parse(resetsAt) > now) ?? [];
      if (!saved || windows.length === 0) {
        return { accountKey: null, observedAt: saved?.observedAt ?? null, usage: {
          status: "error" as const, accountEmail: null, planLabel: null,
          message: "Could not load Gemini quotas. Check your Antigravity sign-in on the host.",
        } };
      }
      const localTime = new Intl.DateTimeFormat("en-GB", {
        day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "UTC",
      }).format(saved.observedAt);
      return { accountKey: null, observedAt: saved.observedAt, usage: {
        status: "ok" as const, accountEmail: null,
        planLabel: `Snapshot ${localTime} UTC${refreshFailed ? " · refresh failed" : ""}`, windows,
      } };
    },
  }, { experimental_discoverable: true, experimental_description: "Gemini quota snapshots from the Antigravity terminal." });
}
