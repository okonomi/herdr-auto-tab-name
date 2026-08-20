import { mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildStampOf } from "../src/build-stamp.js";

async function tempDist(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "herdr-build-"));
  await writeFile(join(dir, "daemon.js"), "", "utf8");
  await writeFile(join(dir, "namer.js"), "", "utf8");
  return dir;
}

/** mtime を指定秒だけ進める。テスト実行が速すぎて差が出ないのを避ける。 */
async function touch(filePath: string, secondsFromNow: number): Promise<void> {
  const at = new Date(Date.now() + secondsFromNow * 1000);
  await utimes(filePath, at, at);
}

describe("buildStampOf", () => {
  it("ディレクトリに変化が無ければ同じ値を返す", async () => {
    const dir = await tempDist();

    expect(await buildStampOf(dir)).toBe(await buildStampOf(dir));
  });

  it("いずれかの .js が新しくなると値が変わる", async () => {
    const dir = await tempDist();
    const before = await buildStampOf(dir);

    await touch(join(dir, "namer.js"), 60);

    expect(await buildStampOf(dir)).not.toBe(before);
  });

  it(".js 以外のファイルが新しくなっても値は変わらない", async () => {
    const dir = await tempDist();
    await writeFile(join(dir, "daemon.js.map"), "", "utf8");
    const before = await buildStampOf(dir);

    await touch(join(dir, "daemon.js.map"), 60);

    expect(await buildStampOf(dir)).toBe(before);
  });

  it(".js が一つも無ければ 0 を返す", async () => {
    const dir = await mkdtemp(join(tmpdir(), "herdr-build-"));

    expect(await buildStampOf(dir)).toBe("0");
  });
});
