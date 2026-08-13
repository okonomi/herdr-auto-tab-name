import { mkdir, mkdtemp, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { withStartLock } from "../src/cli.js";
import { startLockPath } from "../src/env.js";

async function tempStateDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "herdr-lock-"));
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
    const stateDir = await tempStateDir();

    const result = await withStartLock(stateDir, async () => "ok");

    expect(result).toBe("ok");
    expect(await lockExists(startLockPath(stateDir))).toBe(false);
  });

  it("body が例外を投げてもロックは外れ、例外はそのまま伝播する", async () => {
    const stateDir = await tempStateDir();

    await expect(
      withStartLock(stateDir, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await lockExists(startLockPath(stateDir))).toBe(false);
  });

  it("新しいロックが既にあれば body を実行せず in progress を返す", async () => {
    const stateDir = await tempStateDir();
    await mkdir(stateDir, { recursive: true });
    await writeFile(startLockPath(stateDir), "99999", "utf8");

    let called = false;
    const result = await withStartLock(stateDir, async () => {
      called = true;
      return "ok";
    });

    expect(result).toBe("start already in progress");
    expect(called).toBe(false);
  });

  it("30 秒より古いロックは奪って body を実行する", async () => {
    const stateDir = await tempStateDir();
    await mkdir(stateDir, { recursive: true });
    const lockFile = startLockPath(stateDir);
    await writeFile(lockFile, "99999", "utf8");
    const old = new Date(Date.now() - 31_000);
    await utimes(lockFile, old, old);

    const result = await withStartLock(stateDir, async () => "ok");

    expect(result).toBe("ok");
    expect(await lockExists(lockFile)).toBe(false);
  });

  it("EEXIST 以外のエラーは in progress にせずそのまま伝播する", async () => {
    const root = await tempStateDir();
    const blockerFile = join(root, "not-a-dir");
    await writeFile(blockerFile, "blocker", "utf8");
    // 親のパスセグメントがファイルなので、state ディレクトリの作成に失敗する。
    const stateDir = join(blockerFile, "state");

    await expect(withStartLock(stateDir, async () => "ok")).rejects.toThrow();
  });
});
