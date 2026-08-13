import type { HerdrApi } from "./api.js";
import { nextLabel, nextMode } from "./decide.js";
import { resolveTabForeground } from "./namer.js";
import type { StateStore } from "./state.js";
import type { PaneProcessInfo, TabState } from "./types.js";

/**
 * ポーリング 1 周回。snapshot を 1 回取り、自動モードのタブについてのみ
 * ペインのプロセス情報を集め、名前が変わるタブだけリネームする。
 *
 * 途中の失敗はタブ単位で握りつぶす。次の周回でやり直せるため、1 つのタブの
 * 失敗で周回全体を落とす価値がない。
 */
export async function runCycle(
  api: HerdrApi,
  store: StateStore,
  log: (message: string) => void,
): Promise<void> {
  const snapshot = await api.snapshot();

  const panesByTab = new Map<string, string[]>();
  for (const pane of snapshot.panes) {
    const panes = panesByTab.get(pane.tab_id);
    if (panes) panes.push(pane.pane_id);
    else panesByTab.set(pane.tab_id, [pane.pane_id]);
  }

  for (const tab of snapshot.tabs) {
    const stored = store.get(tab.tab_id);
    const mode = nextMode(tab.label, stored);

    // ユーザーが手動固定を解除した(タブ名を番号に戻した)直後は、手動固定の
    // 間に溜まった古い lastCommand/lastSetLabel を引き継がない。引き継ぐと、
    // 何時間も前に動いていたコマンド名へ即座に戻ってしまい、ユーザーの
    // リセット操作が効いていないように見える。
    const reclaimed = stored?.mode === "manual" && mode === "auto";

    const state: TabState = {
      mode,
      lastCommand: reclaimed ? null : (stored?.lastCommand ?? null),
      lastSetLabel: reclaimed ? null : (stored?.lastSetLabel ?? null),
    };

    if (mode === "manual") {
      store.set(tab.tab_id, state);
      continue;
    }

    const infos: PaneProcessInfo[] = [];
    for (const paneId of panesByTab.get(tab.tab_id) ?? []) {
      try {
        infos.push(await api.processInfo(paneId));
      } catch (error) {
        log(`pane.process_info failed for ${paneId}: ${String(error)}`);
      }
    }

    const foreground = resolveTabForeground(infos);
    if (foreground.kind === "running") state.lastCommand = foreground.command;

    const label = nextLabel(foreground, state);
    if (label !== null && label !== tab.label) {
      try {
        await api.rename(tab.tab_id, label);
        state.lastSetLabel = label;
      } catch (error) {
        log(`tab.rename failed for ${tab.tab_id}: ${String(error)}`);
      }
    }

    store.set(tab.tab_id, state);
  }

  store.prune(snapshot.tabs.map((tab) => tab.tab_id));
  await store.save();
}
