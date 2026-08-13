import { createConnection } from "node:net";

export class HerdrApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "HerdrApiError";
  }
}

type Response = {
  id?: string;
  result?: unknown;
  error?: { code: string; message: string };
};

const REQUEST_TIMEOUT_MS = 5_000;

/**
 * herdr の Unix socket クライアント。
 *
 * herdr のサーバはレスポンスを 1 行返すと接続を閉じるので、リクエストごとに
 * 接続を張り直す。常時接続を持たないぶん、サーバの再起動をまたいでも
 * 再接続処理は要らない。
 */
export class SocketClient {
  private counter = 0;

  constructor(
    private readonly socketPath: string,
    private readonly timeoutMs: number = REQUEST_TIMEOUT_MS,
  ) {}

  request<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const id = `auto-tab-name:${++this.counter}`;
    return new Promise<T>((resolve, reject) => {
      const socket = createConnection(this.socketPath);
      let buffer = "";
      let settled = false;

      const timer = setTimeout(() => {
        fail(new Error(`${method}: timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);

      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        reject(error);
      };

      socket.on("error", fail);
      socket.on("close", () => fail(new Error(`${method}: connection closed without a response`)));

      socket.on("connect", () => {
        socket.write(JSON.stringify({ id, method, params }) + "\n");
      });

      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        const newline = buffer.indexOf("\n");
        if (newline === -1) return;

        let response: Response;
        try {
          response = JSON.parse(buffer.slice(0, newline)) as Response;
        } catch (cause) {
          fail(new Error(`${method}: malformed response`, { cause }));
          return;
        }

        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.end();

        if (response.error) {
          reject(new HerdrApiError(response.error.code, response.error.message));
        } else {
          resolve(response.result as T);
        }
      });
    });
  }
}
