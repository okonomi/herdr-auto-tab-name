import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runCycle } from "../src/poller.js";
import { StateStore } from "../src/state.js";
import type { HerdrApi } from "../src/api.js";
import type {
  PaneProcessInfo,
  Snapshot,
  SnapshotPane,
  SnapshotTab,
} from "../src/types.js";
import { idleFish, runningClaude } from "./fixtures/process-info.js";

const tab = (over: Partial<SnapshotTab> & { tab_id: string }): SnapshotTab => ({
  workspace_id: "w1",
  number: 1,
  label: "1",
  focused: false,
  pane_count: 1,
  agent_status: "unknown",
  ...over,
});

const pane = (paneId: string, tabId: string): SnapshotPane => ({
  pane_id: paneId,
  tab_id: tabId,
  workspace_id: "w1",
});

function fakeApi(
  snapshot: Snapshot,
  processInfos: Record<string, PaneProcessInfo>,
): HerdrApi & { renames: Array<[string, string]> } {
  const renames: Array<[string, string]> = [];
  return {
    renames,
    snapshot: async () => snapshot,
    processInfo: async (paneId) => {
      const info = processInfos[paneId];
      if (!info) throw new Error(`no fixture for ${paneId}`);
      return info;
    },
    rename: async (tabId, label) => {
      renames.push([tabId, label]);
    },
  };
}

async function emptyStore(): Promise<StateStore> {
  const dir = await mkdtemp(join(tmpdir(), "herdr-poller-"));
  return StateStore.load(join(dir, "state.json"));
}

const noop = (): void => {};

describe("runCycle", () => {
  it("実行中のコマンド名でタブをリネームする", async () => {
    const api = fakeApi(
      { tabs: [tab({ tab_id: "w1:t1" })], panes: [pane("w1:p1", "w1:t1")] },
      { "w1:p1": runningClaude },
    );
    const store = await emptyStore();

    await runCycle(api, store, noop);

    expect(api.renames).toEqual([["w1:t1", "claude"]]);
    expect(store.get("w1:t1")).toEqual({
      mode: "auto",
      lastCommand: "claude",
      lastSetLabel: "claude",
    });
  });

  it("名前が変わらないなら rename を投げない", async () => {
    const api = fakeApi(
      { tabs: [tab({ tab_id: "w1:t1", label: "claude" })], panes: [pane("w1:p1", "w1:t1")] },
      { "w1:p1": runningClaude },
    );
    const store = await emptyStore();
    store.set("w1:t1", { mode: "auto", lastCommand: "claude", lastSetLabel: "claude" });

    await runCycle(api, store, noop);

    expect(api.renames).toEqual([]);
  });

  it("手動固定のタブは process_info すら取りに行かない", async () => {
    const api = fakeApi(
      { tabs: [tab({ tab_id: "w1:t1", label: "deploy" })], panes: [pane("w1:p1", "w1:t1")] },
      { "w1:p1": runningClaude },
    );
    const spy = vi.spyOn(api, "processInfo");
    const store = await emptyStore();

    await runCycle(api, store, noop);

    expect(spy).not.toHaveBeenCalled();
    expect(api.renames).toEqual([]);
    expect(store.get("w1:t1")?.mode).toBe("manual");
  });

  it("ユーザーが手動リネームしたら手動固定に切り替える", async () => {
    const api = fakeApi(
      { tabs: [tab({ tab_id: "w1:t1", label: "deploy" })], panes: [pane("w1:p1", "w1:t1")] },
      { "w1:p1": runningClaude },
    );
    const store = await emptyStore();
    store.set("w1:t1", { mode: "auto", lastCommand: "claude", lastSetLabel: "claude" });

    await runCycle(api, store, noop);

    expect(api.renames).toEqual([]);
    expect(store.get("w1:t1")?.mode).toBe("manual");
  });

  it("手動固定を自動へ戻すと直前のコマンド名を引き継がない", async () => {
    const api = fakeApi(
      { tabs: [tab({ tab_id: "w1:t1", label: "1" })], panes: [pane("w1:p1", "w1:t1")] },
      { "w1:p1": idleFish },
    );
    const store = await emptyStore();
    store.set("w1:t1", { mode: "manual", lastCommand: "claude", lastSetLabel: null });

    await runCycle(api, store, noop);

    expect(api.renames).toEqual([]);
    expect(store.get("w1:t1")).toEqual({
      mode: "auto",
      lastCommand: null,
      lastSetLabel: null,
    });
  });

  it("アイドルになっても直前のコマンド名を保つ", async () => {
    const api = fakeApi(
      { tabs: [tab({ tab_id: "w1:t1", label: "claude" })], panes: [pane("w1:p1", "w1:t1")] },
      { "w1:p1": idleFish },
    );
    const store = await emptyStore();
    store.set("w1:t1", { mode: "auto", lastCommand: "claude", lastSetLabel: "claude" });

    await runCycle(api, store, noop);

    expect(api.renames).toEqual([]);
    expect(store.get("w1:t1")?.lastCommand).toBe("claude");
  });

  it("一部のペインの process_info が失敗しても残ったペインの情報でリネームする", async () => {
    const api = fakeApi(
      {
        tabs: [tab({ tab_id: "w1:t1" })],
        panes: [pane("w1:p1", "w1:t1"), pane("w1:p2", "w1:t1")],
      },
      { "w1:p2": runningClaude },
    );
    const store = await emptyStore();
    const lines: string[] = [];
    const log = (message: string): void => {
      lines.push(message);
    };

    await runCycle(api, store, log);

    expect(api.renames).toEqual([["w1:t1", "claude"]]);
    expect(lines.some((line) => line.includes("w1:p1"))).toBe(true);
  });

  it("2 ペインのうち片方だけ実行中ならそのコマンド名でリネームする", async () => {
    const api = fakeApi(
      {
        tabs: [tab({ tab_id: "w1:t1" })],
        panes: [pane("w1:p1", "w1:t1"), pane("w1:p2", "w1:t1")],
      },
      { "w1:p1": idleFish, "w1:p2": runningClaude },
    );
    const store = await emptyStore();

    await runCycle(api, store, noop);

    expect(api.renames).toEqual([["w1:t1", "claude"]]);
  });

  it("2 ペインとも実行中なら pane_id の若い方を代表にする", async () => {
    const runningVim: PaneProcessInfo = {
      pane_id: "w1:p2",
      shell_pid: 100,
      foreground_process_group_id: 200,
      foreground_processes: [
        { pid: 200, name: "vim", argv0: "vim", argv: ["vim"], cmdline: "vim", cwd: "/tmp" },
      ],
    };
    const runningNode: PaneProcessInfo = {
      pane_id: "w1:p10",
      shell_pid: 101,
      foreground_process_group_id: 201,
      foreground_processes: [
        { pid: 201, name: "node", argv0: "node", argv: ["node"], cmdline: "node", cwd: "/tmp" },
      ],
    };
    const api = fakeApi(
      {
        tabs: [tab({ tab_id: "w1:t1" })],
        panes: [pane("w1:p10", "w1:t1"), pane("w1:p2", "w1:t1")],
      },
      { "w1:p10": runningNode, "w1:p2": runningVim },
    );
    const store = await emptyStore();

    await runCycle(api, store, noop);

    expect(api.renames).toEqual([["w1:t1", "vim"]]);
  });

  it("ペインの情報が 1 つもないタブは rename されない", async () => {
    const api = fakeApi({ tabs: [tab({ tab_id: "w1:t1" })], panes: [] }, {});
    const store = await emptyStore();

    await expect(runCycle(api, store, noop)).resolves.toBeUndefined();

    expect(api.renames).toEqual([]);
  });

  it("rename が失敗しても例外を投げない", async () => {
    const api = fakeApi(
      { tabs: [tab({ tab_id: "w1:t1" })], panes: [pane("w1:p1", "w1:t1")] },
      { "w1:p1": runningClaude },
    );
    api.rename = async () => {
      throw new Error("tab_not_found");
    };
    const store = await emptyStore();
    const lines: string[] = [];
    const log = (message: string): void => {
      lines.push(message);
    };

    await expect(runCycle(api, store, log)).resolves.toBeUndefined();
    expect(store.get("w1:t1")?.lastSetLabel).toBeNull();
    expect(lines.some((line) => line.includes("w1:t1"))).toBe(true);
  });

  it("自動命名したタブ名を番号へ戻すとリセットとして扱い、直前のコマンド名を忘れる", async () => {
    const api = fakeApi(
      { tabs: [tab({ tab_id: "w1:t1", label: "1" })], panes: [pane("w1:p1", "w1:t1")] },
      { "w1:p1": idleFish },
    );
    const store = await emptyStore();
    store.set("w1:t1", { mode: "auto", lastCommand: "claude", lastSetLabel: "claude" });

    await runCycle(api, store, noop);

    expect(api.renames).toEqual([]);
    expect(store.get("w1:t1")).toEqual({
      mode: "auto",
      lastCommand: null,
      lastSetLabel: null,
    });
  });

  it("番号へ戻した直後でもコマンドが実際に実行中ならリネームを抑制しない", async () => {
    const api = fakeApi(
      { tabs: [tab({ tab_id: "w1:t1", label: "1" })], panes: [pane("w1:p1", "w1:t1")] },
      { "w1:p1": runningClaude },
    );
    const store = await emptyStore();
    store.set("w1:t1", { mode: "auto", lastCommand: "claude", lastSetLabel: "claude" });

    await runCycle(api, store, noop);

    expect(api.renames).toEqual([["w1:t1", "claude"]]);
    expect(store.get("w1:t1")).toEqual({
      mode: "auto",
      lastCommand: "claude",
      lastSetLabel: "claude",
    });
  });

  it("一度も自動命名していない新規タブは番号のままでもリセット扱いにしない", async () => {
    const api = fakeApi(
      { tabs: [tab({ tab_id: "w1:t1", label: "1" })], panes: [pane("w1:p1", "w1:t1")] },
      { "w1:p1": idleFish },
    );
    const store = await emptyStore();

    await expect(runCycle(api, store, noop)).resolves.toBeUndefined();

    expect(api.renames).toEqual([]);
    expect(store.get("w1:t1")).toEqual({
      mode: "auto",
      lastCommand: null,
      lastSetLabel: null,
    });
  });

  it("foreground_processes が欠けた壊れたペイン情報があっても、そのタブだけ諦めて他のタブは処理する", async () => {
    const malformed = {
      pane_id: "w1:p1",
      shell_pid: 100,
      foreground_process_group_id: 100,
      foreground_processes: undefined,
    } as unknown as PaneProcessInfo;
    const api = fakeApi(
      {
        tabs: [tab({ tab_id: "w1:t1" }), tab({ tab_id: "w1:t2" })],
        panes: [pane("w1:p1", "w1:t1"), pane("w1:p2", "w1:t2")],
      },
      { "w1:p1": malformed, "w1:p2": runningClaude },
    );
    const store = await emptyStore();

    await expect(runCycle(api, store, noop)).resolves.toBeUndefined();

    expect(api.renames).toEqual([["w1:t2", "claude"]]);
  });

  it("計算したラベルが空文字列ならリネームしない", async () => {
    const emptyArgv0: PaneProcessInfo = {
      pane_id: "w1:p1",
      shell_pid: 100,
      foreground_process_group_id: 200,
      foreground_processes: [
        { pid: 200, name: "?", argv0: "/", argv: ["/"], cmdline: "/", cwd: "/" },
      ],
    };
    const api = fakeApi(
      { tabs: [tab({ tab_id: "w1:t1" })], panes: [pane("w1:p1", "w1:t1")] },
      { "w1:p1": emptyArgv0 },
    );
    const store = await emptyStore();

    await runCycle(api, store, noop);

    expect(api.renames).toEqual([]);
  });

  it("64 文字を超えるラベルは切り詰めてからリネームする", async () => {
    const longName = "a".repeat(100);
    const longArgv0: PaneProcessInfo = {
      pane_id: "w1:p1",
      shell_pid: 100,
      foreground_process_group_id: 200,
      foreground_processes: [
        {
          pid: 200,
          name: longName,
          argv0: longName,
          argv: [longName],
          cmdline: longName,
          cwd: "/",
        },
      ],
    };
    const api = fakeApi(
      { tabs: [tab({ tab_id: "w1:t1" })], panes: [pane("w1:p1", "w1:t1")] },
      { "w1:p1": longArgv0 },
    );
    const store = await emptyStore();

    await runCycle(api, store, noop);

    expect(api.renames).toEqual([["w1:t1", "a".repeat(64)]]);
  });

  it("消えたタブの状態を捨てる", async () => {
    const api = fakeApi(
      { tabs: [tab({ tab_id: "w1:t1", label: "claude" })], panes: [pane("w1:p1", "w1:t1")] },
      { "w1:p1": runningClaude },
    );
    const store = await emptyStore();
    store.set("w1:t9", { mode: "auto", lastCommand: "vim", lastSetLabel: "vim" });

    await runCycle(api, store, noop);

    expect(store.get("w1:t9")).toBeUndefined();
  });
});
