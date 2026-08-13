import { describe, expect, it } from "vitest";
import { FailureTracker } from "../src/failure-tracker.js";

describe("FailureTracker", () => {
  it("最初の失敗では諦めない", () => {
    const tracker = new FailureTracker(30_000);
    expect(tracker.recordFailure(1_000)).toBe(false);
  });

  it("失敗が制限時間を超えて続いたら諦める", () => {
    const tracker = new FailureTracker(30_000);
    expect(tracker.recordFailure(1_000)).toBe(false);
    expect(tracker.recordFailure(20_000)).toBe(false);
    expect(tracker.recordFailure(31_001)).toBe(true);
  });

  it("成功したら失敗の連続がリセットされる", () => {
    const tracker = new FailureTracker(30_000);
    tracker.recordFailure(1_000);
    tracker.recordSuccess(20_000);
    expect(tracker.recordFailure(40_000)).toBe(false);
    expect(tracker.recordFailure(60_000)).toBe(false);
  });

  it("ちょうど制限時間では諦めない", () => {
    const tracker = new FailureTracker(30_000);
    tracker.recordFailure(1_000);
    expect(tracker.recordFailure(31_000)).toBe(false);
  });
});
