import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readAntigravityQuota } from "./manual-refresh.ts";

type Driver = Parameters<typeof readAntigravityQuota>[0];
const readyScreen = "Antigravity CLI\r\n? for shortcuts\r\n";
const quotaScreen = [
  "Models & Quota",
  "GEMINI MODELS",
  "Weekly Limit Remaining",
  "[████░] 78.25%",
  "Refreshes in 150h 0m",
  "Five Hour Limit Remaining",
  "[████░] 72.50%",
  "Refreshes in 2h 10m",
  "CLAUDE AND GPT MODELS",
].join("\r\n");

function terminalFixture(
  status: "running" | "exited",
  executablePath = join(homedir(), ".local", "bin", "agy"),
) {
  const events: string[] = [];
  const terminalId = "term_faketerm01";
  const terminal = { id: terminalId, rows: 45, cols: 120 } as Awaited<ReturnType<Driver["create"]>>;
  const driver: Driver = {
    async create(args) {
      assert.deepEqual(args.start, { mode: "argv", argv: [executablePath] });
      assert.deepEqual(args.scope, { kind: "host_path", hostId: "host_test", cwd: "/test" });
      events.push("create");
      return terminal;
    },
    async output(args) {
      assert.equal(args.terminalId, terminalId);
      const text = events.includes("input") ? readyScreen + quotaScreen : readyScreen;
      return {
        chunks: [{ dataBase64: Buffer.from(text).toString("base64"), seq: 0 }],
        nextSeq: 1,
        exitCode: status === "exited" ? 1 : null,
        closeReason: status === "exited" ? "process-exit" : null,
        status,
        truncated: false,
      };
    },
    async input(args) {
      assert.equal(args.terminalId, terminalId);
      assert.equal(Buffer.from(args.dataBase64, "base64").toString(), "/usage\r");
      events.push("input");
      return terminal;
    },
    async close(args) {
      assert.equal(args.terminalId, terminalId);
      events.push("close");
      return terminal;
    },
  };
  return { driver, events };
}

test("refresh submits just /usage and closes its own terminal after collecting both windows", async () => {
  const { driver, events } = terminalFixture("running");
  const frame = await readAntigravityQuota(driver, "host_test", "/test");
  assert.equal(frame.weekly.remainingPercent, 78.25);
  assert.equal(frame.fiveHour.resetInMinutes, 130);
  assert.deepEqual(events, ["create", "input", "close"]);
});

test("refresh uses the configured executable on the terminal host", async () => {
  const executablePath = "/opt/custom Antigravity/bin/agy";
  const { driver, events } = terminalFixture("exited", executablePath);
  await assert.rejects(readAntigravityQuota(driver, "host_test", "/test", executablePath));
  assert.deepEqual(events, ["create", "close"]);
});

test("refresh closes a failed terminal without sending input", async () => {
  const { driver, events } = terminalFixture("exited");
  await assert.rejects(readAntigravityQuota(driver, "host_test", "/test"), /exited before returning quotas/);
  assert.deepEqual(events, ["create", "close"]);
});
