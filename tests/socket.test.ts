import { createServer, type Server } from "node:net";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HerdrApiError, SocketClient } from "../src/socket.js";

let server: Server | undefined;

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});

/**
 * herdr サーバを模したソケット。1 行受け取ったらレスポンスを 1 行返し、
 * 実物と同じように接続を閉じる。
 */
async function startFakeServer(
  handler: (request: { id: string; method: string; params: unknown }) => unknown,
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "herdr-sock-"));
  const path = join(dir, "test.sock");
  server = createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      const request = JSON.parse(buffer.slice(0, newline));
      socket.end(JSON.stringify(handler(request)) + "\n");
    });
  });
  await new Promise<void>((resolve) => server!.listen(path, resolve));
  return path;
}

describe("SocketClient", () => {
  it("リクエストを送って result を受け取る", async () => {
    const path = await startFakeServer((req) => ({
      id: req.id,
      result: { type: "pane_process_info", echo: req.params },
    }));
    const client = new SocketClient(path);
    await expect(
      client.request("pane.process_info", { pane_id: "w1:p1" }),
    ).resolves.toEqual({ type: "pane_process_info", echo: { pane_id: "w1:p1" } });
  });

  it("接続ごとに独立してリクエストできる(サーバが接続を閉じても次が通る)", async () => {
    const path = await startFakeServer((req) => ({ id: req.id, result: { method: req.method } }));
    const client = new SocketClient(path);
    await expect(client.request("session.snapshot", {})).resolves.toEqual({
      method: "session.snapshot",
    });
    await expect(client.request("tab.rename", {})).resolves.toEqual({
      method: "tab.rename",
    });
  });

  it("error レスポンスは HerdrApiError にする", async () => {
    const path = await startFakeServer((req) => ({
      id: req.id,
      error: { code: "tab_not_found", message: "tab zz:t9 not found" },
    }));
    const client = new SocketClient(path);
    await expect(client.request("tab.rename", {})).rejects.toThrow(HerdrApiError);
    await expect(client.request("tab.rename", {})).rejects.toMatchObject({
      code: "tab_not_found",
    });
  });

  it("サーバが居なければ reject する", async () => {
    const dir = await mkdtemp(join(tmpdir(), "herdr-sock-"));
    const client = new SocketClient(join(dir, "missing.sock"));
    await expect(client.request("session.snapshot", {})).rejects.toThrow();
  });
});
