import { describe, expect, it } from "vitest";
import {
  logPath,
  pidPath,
  readPluginEnv,
  startLockPath,
  statePath,
  type PluginEnv,
} from "../src/env.js";

const DEFAULT_SOCKET = "/Users/okonomi/.config/herdr/herdr.sock";
const NAMED_SOCKET = "/Users/okonomi/.config/herdr/sessions/work/herdr.sock";

const envFor = (socketPath: string): PluginEnv =>
  readPluginEnv({
    HERDR_SOCKET_PATH: socketPath,
    HERDR_PLUGIN_STATE_DIR: "/state",
  });

describe("readPluginEnv", () => {
  it("socket パスと state ディレクトリを読む", () => {
    const env = envFor(DEFAULT_SOCKET);
    expect(env.socketPath).toBe(DEFAULT_SOCKET);
    expect(env.stateDir).toBe("/state");
  });

  it("HERDR_SOCKET_PATH が無ければ起動を止める", () => {
    expect(() => readPluginEnv({ HERDR_PLUGIN_STATE_DIR: "/state" })).toThrow(
      /HERDR_SOCKET_PATH/,
    );
  });

  it("HERDR_PLUGIN_STATE_DIR が無ければ起動を止める", () => {
    expect(() => readPluginEnv({ HERDR_SOCKET_PATH: DEFAULT_SOCKET })).toThrow(
      /HERDR_PLUGIN_STATE_DIR/,
    );
  });

  it("sessionKey は 8 桁の小文字 16 進になる", () => {
    expect(envFor(DEFAULT_SOCKET).sessionKey).toMatch(/^[0-9a-f]{8}$/);
  });

  it("同じ socket からは毎回同じ sessionKey が出る", () => {
    expect(envFor(DEFAULT_SOCKET).sessionKey).toBe(envFor(DEFAULT_SOCKET).sessionKey);
  });

  it("socket が違えば sessionKey も違う", () => {
    // herdr の名前付きセッションはセッションごとに独自の socket を持つ。
    // ここが同じキーになると、2 つめのセッションが 1 つめのデーモンを見て
    // 「もう動いている」と誤判断し、そのセッションではタブ名が更新されない。
    expect(envFor(DEFAULT_SOCKET).sessionKey).not.toBe(envFor(NAMED_SOCKET).sessionKey);
  });
});

describe("state ディレクトリ内のパス", () => {
  it("セッションごとにファイル名が分かれる", () => {
    const a = envFor(DEFAULT_SOCKET);
    const b = envFor(NAMED_SOCKET);

    expect(statePath(a)).not.toBe(statePath(b));
    expect(pidPath(a)).not.toBe(pidPath(b));
    expect(logPath(a)).not.toBe(logPath(b));
    expect(startLockPath(a)).not.toBe(startLockPath(b));
  });

  it("同じ state ディレクトリの下に sessionKey 付きで並ぶ", () => {
    const env = envFor(DEFAULT_SOCKET);
    const key = env.sessionKey;

    expect(statePath(env)).toBe(`/state/state-${key}.json`);
    expect(pidPath(env)).toBe(`/state/daemon-${key}.json`);
    expect(logPath(env)).toBe(`/state/daemon-${key}.log`);
    expect(startLockPath(env)).toBe(`/state/start-${key}.lock`);
  });
});
