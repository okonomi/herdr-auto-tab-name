/**
 * 連続失敗がどれだけ続いたかを追う。herdr server が落ちたときに
 * デーモンが永久に空回りするのを防ぐ。
 */
export class FailureTracker {
  private firstFailureAt: number | null = null;

  constructor(private readonly limitMs: number) {}

  recordSuccess(_now: number): void {
    this.firstFailureAt = null;
  }

  /** 諦めるべきなら true を返す。 */
  recordFailure(now: number): boolean {
    if (this.firstFailureAt === null) {
      this.firstFailureAt = now;
      return false;
    }
    return now - this.firstFailureAt > this.limitMs;
  }
}
