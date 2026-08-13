import type { PaneProcessInfo, Snapshot } from "./types.js";
import type { SocketClient } from "./socket.js";

/** Poller が必要とする herdr 操作だけを切り出したインターフェース。テストでは偽物に差し替える。 */
export interface HerdrApi {
  snapshot(): Promise<Snapshot>;
  processInfo(paneId: string): Promise<PaneProcessInfo>;
  rename(tabId: string, label: string): Promise<void>;
}

export class SocketHerdrApi implements HerdrApi {
  constructor(private readonly client: SocketClient) {}

  async snapshot(): Promise<Snapshot> {
    const result = await this.client.request<{ snapshot: Snapshot }>("session.snapshot", {});
    return result.snapshot;
  }

  async processInfo(paneId: string): Promise<PaneProcessInfo> {
    const result = await this.client.request<{ process_info: PaneProcessInfo }>(
      "pane.process_info",
      { pane_id: paneId },
    );
    return result.process_info;
  }

  async rename(tabId: string, label: string): Promise<void> {
    await this.client.request("tab.rename", { tab_id: tabId, label });
  }
}
