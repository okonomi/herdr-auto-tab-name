import type { HerdrApi } from "./api.js";
import { isDefaultLabel, nextLabel, nextMode } from "./decide.js";
import { resolveTabForeground } from "./namer.js";
import type { StateStore } from "./state.js";
import type { PaneProcessInfo, TabState } from "./types.js";

/**
 * タブ名の最大長。argv0 のベース名は基本的に短いが、壊れたコマンド名や
 * 異常に長いパスから作られると際限なく長くなりうる。空文字列や長すぎる
 * ラベルは rename が失敗し続ける原因になるため、送る前に切り詰める。
 */
const MAX_LABEL_LENGTH = 64;

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
    // タブ 1 件の処理全体を try で囲む。resolveTabForeground や nextMode は
    // 一見純粋だが、herdr が返す壊れた/欠けたペイン情報(シェルの起動前後、
    // 死にかけのペイン、プラグイン専有ペインなど)を渡されると例外を投げうる。
    // ここで拾わずに投げっぱなしにすると、for ループごと抜けてこの snapshot
    // 内の残り全タブが処理されず、prune/save も走らず、失敗が
    // FailureTracker の 30 秒ぶんの猶予まで消費してしまう(herdr 自体が落ちて
    // いる場合と区別できない)。1 タブの異常は 1 タブに留める。
    try {
      const stored = store.get(tab.tab_id);
      const mode = nextMode(tab.label, stored);

      // ユーザーがタブ名を番号に戻した直後は、古い lastCommand/lastSetLabel を
      // 引き継がない。手動固定からの解除(stored.mode === "manual")だけでなく、
      // このプラグイン自身が付けた名前(stored.mode === "auto" で
      // lastSetLabel === tab.label)からユーザーが番号へリネームした場合も同じ
      // リセット操作とみなす。後者を見逃すと、次の周回で nextMode が「タブ名 !==
      // lastSetLabel」から自動モードのまま残った lastCommand を読み、ユーザーが
      // 番号に戻したはずのタブが 1 秒も経たずに元の名前へリネームされ直してし
      // まい、ユーザーの操作が無かったことになる。
      // stored が無い、または一度も自動命名していない(lastSetLabel === null)
      // タブは、単なる新規タブであってリセットではないため対象外にする。
      const reclaimed =
        stored !== undefined &&
        isDefaultLabel(tab.label) &&
        (stored.mode === "manual" ||
          (stored.lastSetLabel !== null && stored.lastSetLabel !== tab.label));

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

      const rawLabel = nextLabel(foreground, state);
      const label =
        rawLabel !== null && rawLabel.length > MAX_LABEL_LENGTH
          ? rawLabel.slice(0, MAX_LABEL_LENGTH)
          : rawLabel;
      if (label !== null && label.length > 0 && label !== tab.label) {
        try {
          await api.rename(tab.tab_id, label);
          state.lastSetLabel = label;
        } catch (error) {
          log(`tab.rename failed for ${tab.tab_id}: ${String(error)}`);
        }
      }

      store.set(tab.tab_id, state);
    } catch (error) {
      log(`tab ${tab.tab_id} processing failed: ${String(error)}`);
    }
  }

  store.prune(snapshot.tabs.map((tab) => tab.tab_id));
  await store.save();
}
