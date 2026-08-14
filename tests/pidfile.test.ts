import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  commandLineOf,
  isAlive,
  isRunningDaemon,
  readRecord,
  removeOwnedRecord,
  removeRecord,
  writeRecord,
  type DaemonRecord,
} from "../src/pidfile.js";

async function tempPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "herdr-pid-"));
  return join(dir, "daemon.json");
}

const record = (over: Partial<DaemonRecord> = {}): DaemonRecord => ({
  pid: 4242,
  script: "/opt/plugin/dist/daemon.js",
  startedAt: "2026-08-13T00:00:00.000Z",
  ...over,
});

describe("pidfile", () => {
  it("ファイルが無ければ null", async () => {
    expect(await readRecord(await tempPath())).toBeNull();
  });

  it("書いた内容を読み戻せる", async () => {
    const path = await tempPath();
    await writeRecord(path, record());
    expect(await readRecord(path)).toEqual(record());
  });

  it("壊れた JSON は null として扱う", async () => {
    const path = await tempPath();
    await writeFile(path, "{ not json", "utf8");
    expect(await readRecord(path)).toBeNull();
  });

  it("形の合わない JSON は null として扱う", async () => {
    const path = await tempPath();
    await writeFile(path, JSON.stringify({ pid: "abc" }), "utf8");
    expect(await readRecord(path)).toBeNull();
  });

  it("消したあとは null になる", async () => {
    const path = await tempPath();
    await writeRecord(path, record());
    await removeRecord(path);
    expect(await readRecord(path)).toBeNull();
  });

  it("存在しないファイルを消してもエラーにしない", async () => {
    await expect(removeRecord(await tempPath())).resolves.toBeUndefined();
  });
});

describe("isAlive", () => {
  it("自分自身のプロセスは生きている", () => {
    expect(isAlive(process.pid)).toBe(true);
  });

  it("存在しない pid は生きていない", () => {
    expect(isAlive(2_147_483_646)).toBe(false);
  });
});

describe("commandLineOf", () => {
  it("自分自身のコマンドラインが取れる", () => {
    expect(commandLineOf(process.pid)).toContain("node");
  });

  it("存在しない pid では null", () => {
    expect(commandLineOf(2_147_483_646)).toBeNull();
  });
});

describe("isRunningDaemon", () => {
  it("記録が無ければ動いていない", () => {
    expect(isRunningDaemon(null)).toBe(false);
  });

  it("pid が生きていなければ動いていない", () => {
    expect(isRunningDaemon(record({ pid: 2_147_483_646 }))).toBe(false);
  });

  it("pid は生きていてもコマンドラインが一致しなければ動いていない", () => {
    // 自分自身の pid だが、script は vitest のコマンドラインに現れない偽のパス。
    // pid 再利用で無関係なプロセスを掴むケースを模している。
    expect(
      isRunningDaemon(record({ pid: process.pid, script: "/nonexistent/daemon.js" })),
    ).toBe(false);
  });

  it("pid が生きていてコマンドラインに script が現れれば動いている", () => {
    const commandLine = commandLineOf(process.pid) ?? "";
    const token = commandLine.split(/\s+/).find((part) => part.includes("/")) ?? "node";
    expect(isRunningDaemon(record({ pid: process.pid, script: token }))).toBe(true);
  });
});

describe("removeOwnedRecord", () => {
  it("自分の pid が記録されていれば消す", async () => {
    const path = await tempPath();
    await writeRecord(path, record({ pid: 4242 }));
    await removeOwnedRecord(path, 4242);
    expect(await readRecord(path)).toBeNull();
  });

  it("別の pid が記録されていれば消さない", async () => {
    // stop が SIGTERM を送ってから相手が死ぬまでの間に別経路の start が走り、
    // 新しいデーモンの record が書かれた状況。これを消すと新デーモンが
    // status からも stop からも見えない孤児になる。
    const path = await tempPath();
    const other = record({ pid: 9999 });
    await writeRecord(path, other);
    await removeOwnedRecord(path, 4242);
    expect(await readRecord(path)).toEqual(other);
  });

  it("ファイルが無くてもエラーにしない", async () => {
    await expect(removeOwnedRecord(await tempPath(), 4242)).resolves.toBeUndefined();
  });

  it("壊れた record は誰のものか判断できないので消さない", async () => {
    const path = await tempPath();
    await writeFile(path, "{ not json", "utf8");
    await removeOwnedRecord(path, 4242);
    expect(await readFile(path, "utf8")).toBe("{ not json");
  });
});
