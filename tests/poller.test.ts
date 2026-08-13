import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runCycle } from "../src/poller.js";
import { StateStore } from "../src/state.js";
import type { HerdrApi } from "../src/api.js";
import type { PaneProcessInfo, Snapshot, SnapshotPane, SnapshotTab } from "../src/types.js";
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

  it("ペインの process_info が失敗してもそのタブを飛ばして続ける", async () => {
    const api = fakeApi(
      {
        tabs: [tab({ tab_id: "w1:t1" }), tab({ tab_id: "w1:t2", number: 2, label: "2" })],
        panes: [pane("w1:p1", "w1:t1"), pane("w1:p2", "w1:t2")],
      },
      { "w1:p2": runningClaude },
    );
    const store = await emptyStore();

    await runCycle(api, store, noop);

    expect(api.renames).toEqual([["w1:t2", "claude"]]);
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

    await expect(runCycle(api, store, noop)).resolves.toBeUndefined();
    expect(store.get("w1:t1")?.lastSetLabel).toBeNull();
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
