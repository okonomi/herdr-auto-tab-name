import { chmod, mkdir, mkdtemp, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { withStartLock } from "../src/cli.js";
import { readPluginEnv, startLockPath, type PluginEnv } from "../src/env.js";

async function tempEnv(): Promise<PluginEnv> {
  const stateDir = await mkdtemp(join(tmpdir(), "herdr-lock-"));
  return readPluginEnv({
    HERDR_SOCKET_PATH: join(stateDir, "herdr.sock"),
    HERDR_PLUGIN_STATE_DIR: stateDir,
  });
}

async function lockExists(lockFile: string): Promise<boolean> {
  try {
    await stat(lockFile);
    return true;
  } catch {
    return false;
  }
}

describe("withStartLock", () => {
  it("ロックが無ければ body を実行し、終了後にロックファイルを残さない", async () => {
    const env = await tempEnv();

    const result = await withStartLock(env, async () => "ok");

    expect(result).toBe("ok");
    expect(await lockExists(startLockPath(env))).toBe(false);
  });

  it("body が例外を投げてもロックは外れ、例外はそのまま伝播する", async () => {
    const env = await tempEnv();

    await expect(
      withStartLock(env, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await lockExists(startLockPath(env))).toBe(false);
  });

  it("新しいロックが既にあれば body を実行せず in progress を返す", async () => {
    const env = await tempEnv();
    await mkdir(env.stateDir, { recursive: true });
    await writeFile(startLockPath(env), "99999", "utf8");

    let called = false;
    const result = await withStartLock(env, async () => {
      called = true;
      return "ok";
    });

    expect(result).toBe("start already in progress");
    expect(called).toBe(false);
  });

  it("30 秒より古いロックは奪って body を実行する", async () => {
    const env = await tempEnv();
    await mkdir(env.stateDir, { recursive: true });
    const lockFile = startLockPath(env);
    await writeFile(lockFile, "99999", "utf8");
    const old = new Date(Date.now() - 31_000);
    await utimes(lockFile, old, old);

    const result = await withStartLock(env, async () => "ok");

    expect(result).toBe("ok");
    expect(await lockExists(lockFile)).toBe(false);
  });

  it("EEXIST 以外のエラーは in progress にせずそのまま伝播する", async () => {
    // state ディレクトリ自体は(既に存在するので)作れるが、書き込み権限を外して
    // open(lockFile, "wx") 自体を EACCES で失敗させる。これで
    // tryAcquireStartLock の「EEXIST 以外は投げる」分岐を直接通す。
    const env = await tempEnv();
    await chmod(env.stateDir, 0o500);
    try {
      await expect(withStartLock(env, async () => "ok")).rejects.toThrow();
    } finally {
      await chmod(env.stateDir, 0o700);
    }
  });
});
