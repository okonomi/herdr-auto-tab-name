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

      // chunk.toString("utf8") をチャンクごとに呼ぶと、マルチバイト文字が
      // チャンクの境界をまたいだときに文字化け(replacement character)する。
      // setEncoding("utf8") を張っておけば、Node のストリームデコーダが
      // 未完成のバイト列をチャンクをまたいで保持してくれる。
      socket.setEncoding("utf8");

      socket.on("connect", () => {
        socket.write(JSON.stringify({ id, method, params }) + "\n");
      });

      socket.on("data", (chunk: string) => {
        buffer += chunk;
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

        // JSON-RPC 的な契約として、整形されたレスポンスは result か error の
        // どちらか一方を必ず持つ。どちらも無いレスポンスをそのまま
        // `response.result as T` で解決すると undefined が返り、呼び出し元
        // (api.ts)で 1 段離れた分かりにくい TypeError になってしまう。ここで
        // 早めに、どのメソッドの呼び出しで何が起きたか分かる形で reject する。
        if (response.error) {
          settled = true;
          clearTimeout(timer);
          socket.end();
          reject(new HerdrApiError(response.error.code, response.error.message));
        } else if ("result" in response) {
          settled = true;
          clearTimeout(timer);
          socket.end();
          resolve(response.result as T);
        } else {
          fail(new Error(`${method}: response had neither result nor error`));
        }
      });
    });
  }
}
