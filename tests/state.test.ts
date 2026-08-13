import { mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { StateStore } from "../src/state.js";
import type { TabState } from "../src/types.js";

const claudeState: TabState = {
  mode: "auto",
  lastCommand: "claude",
  lastSetLabel: "claude",
};

async function tempFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "herdr-auto-tab-name-"));
  return join(dir, "state.json");
}

describe("StateStore", () => {
  it("ファイルが無ければ空の状態から始まる", async () => {
    const store = await StateStore.load(await tempFile());
    expect(store.get("w1:t1")).toBeUndefined();
  });

  it("保存した状態を読み直せる", async () => {
    const path = await tempFile();
    const store = await StateStore.load(path);
    store.set("w1:t1", claudeState);
    await store.save();

    const reloaded = await StateStore.load(path);
    expect(reloaded.get("w1:t1")).toEqual(claudeState);
  });

  it("壊れた JSON は空の状態として扱う", async () => {
    const path = await tempFile();
    await writeFile(path, "{ this is not json", "utf8");
    const store = await StateStore.load(path);
    expect(store.get("w1:t1")).toBeUndefined();
  });

  it("生きていないタブの状態を捨てる", async () => {
    const store = await StateStore.load(await tempFile());
    store.set("w1:t1", claudeState);
    store.set("w1:t2", claudeState);
    store.prune(["w1:t1"]);
    expect(store.get("w1:t1")).toEqual(claudeState);
    expect(store.get("w1:t2")).toBeUndefined();
  });

  it("保存先のディレクトリが無ければ作る", async () => {
    const dir = await mkdtemp(join(tmpdir(), "herdr-auto-tab-name-"));
    const path = join(dir, "nested", "state.json");
    const store = await StateStore.load(path);
    store.set("w1:t1", claudeState);
    await store.save();
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ "w1:t1": claudeState });
  });

  it("ディレクトリを 0700、ファイルを 0600 で作る", async () => {
    const dir = await mkdtemp(join(tmpdir(), "herdr-auto-tab-name-"));
    const path = join(dir, "nested", "state.json");
    const store = await StateStore.load(path);
    store.set("w1:t1", claudeState);
    await store.save();

    expect((await stat(dirname(path))).mode & 0o777).toBe(0o700);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("書き込み後に一時ファイルを残さない", async () => {
    const dir = await mkdtemp(join(tmpdir(), "herdr-auto-tab-name-"));
    const path = join(dir, "state.json");
    const store = await StateStore.load(path);
    store.set("w1:t1", claudeState);
    await store.save();

    expect(await readdir(dir)).toEqual(["state.json"]);
  });
});
