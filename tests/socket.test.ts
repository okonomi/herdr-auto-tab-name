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

  it("サーバが応答しないままだとタイムアウトで reject する", async () => {
    const dir = await mkdtemp(join(tmpdir(), "herdr-sock-"));
    const path = join(dir, "test.sock");
    server = createServer((socket) => {
      // 接続は受け付けるが、何も返さず閉じもしない。resume() しないと
      // ソケットが一時停止状態のままになり、クライアント側の destroy() で
      // 送られる FIN/RST をこの端が拾わず、afterEach の server.close() が
      // ハングしてしまうため呼んでおく。
      socket.resume();
    });
    await new Promise<void>((resolve) => server!.listen(path, resolve));

    const client = new SocketClient(path, 50);
    await expect(client.request("session.snapshot", {})).rejects.toThrow(/timed out/);
  });

  it("result も error も無いレスポンスは、メソッド名入りのエラーで reject する", async () => {
    const path = await startFakeServer((req) => ({ id: req.id }));
    const client = new SocketClient(path);
    await expect(client.request("tab.rename", {})).rejects.toThrow(/tab\.rename/);
  });

  it("マルチバイト文字がチャンクの境界で分割されても正しくデコードする", async () => {
    const dir = await mkdtemp(join(tmpdir(), "herdr-sock-"));
    const path = join(dir, "test.sock");
    const label = "実装を進める";

    server = createServer((socket) => {
      let buffer = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        const newline = buffer.indexOf("\n");
        if (newline === -1) return;
        const request = JSON.parse(buffer.slice(0, newline)) as { id: string };
        const payload = Buffer.from(
          JSON.stringify({ id: request.id, result: { label } }) + "\n",
          "utf8",
        );
        // "進" (U+9032) は utf8 で 3 バイト。その文字の途中で分割して 2 回に分けて書く。
        const marker = Buffer.from("進", "utf8");
        const markerIndex = payload.indexOf(marker);
        const splitAt = markerIndex + 1; // マーカーの 1 バイト目の直後、つまり文字の途中。

        socket.write(payload.subarray(0, splitAt));
        setTimeout(() => {
          socket.end(payload.subarray(splitAt));
        }, 10);
      });
    });
    await new Promise<void>((resolve) => server!.listen(path, resolve));

    const client = new SocketClient(path);
    await expect(client.request("tab.rename", { label })).resolves.toEqual({ label });
  });

  it("タイムアウトを短く設定していても、正常な通信では毎回解決する", async () => {
    const path = await startFakeServer((req) => ({ id: req.id, result: { method: req.method } }));
    const client = new SocketClient(path, 50);
    await expect(client.request("session.snapshot", {})).resolves.toEqual({
      method: "session.snapshot",
    });
    await expect(client.request("tab.rename", {})).resolves.toEqual({
      method: "tab.rename",
    });
  });
});
