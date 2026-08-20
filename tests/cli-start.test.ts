import { describe, expect, it } from "vitest";
import { planStart } from "../src/cli.js";
import type { DaemonRecord } from "../src/pidfile.js";

const record = (over: Partial<DaemonRecord> = {}): DaemonRecord => ({
  pid: 4242,
  script: "/opt/plugin/dist/daemon.js",
  startedAt: "2026-08-13T00:00:00.000Z",
  buildStamp: "100",
  ...over,
});

describe("planStart", () => {
  it("記録が無ければ起動する", () => {
    expect(planStart(null, false, "100")).toBe("spawn");
  });

  it("記録があってもデーモンが走っていなければ起動する", () => {
    expect(planStart(record(), false, "100")).toBe("spawn");
  });

  it("走っていてビルドが同じなら何もしない", () => {
    expect(planStart(record({ buildStamp: "100" }), true, "100")).toBe("keep");
  });

  it("走っていてもビルドが変わっていれば入れ替える", () => {
    // プラグインを更新しても、走っているプロセス内のコードは差し替わらない。
    expect(planStart(record({ buildStamp: "100" }), true, "200")).toBe("replace");
  });

  it("走っていて buildStamp を持たない古い記録なら入れ替える", () => {
    expect(planStart(record({ buildStamp: undefined }), true, "100")).toBe("replace");
  });
});
