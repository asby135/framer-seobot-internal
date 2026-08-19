import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createPublishDebouncer } from "./publish-debounce.js";

describe("publish debouncer", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const make = (publish = vi.fn(async () => {}), onError = vi.fn(async () => {})) => ({
    publish,
    onError,
    d: createPublishDebouncer({ delayMs: 1000, publish, onError }),
  });

  it("does not publish before the delay elapses", async () => {
    const { publish, d } = make();
    d.schedule();
    await vi.advanceTimersByTimeAsync(999);
    expect(publish).not.toHaveBeenCalled();
  });

  it("publishes once the delay elapses", async () => {
    const { publish, d } = make();
    d.schedule();
    await vi.advanceTimersByTimeAsync(1000);
    expect(publish).toHaveBeenCalledOnce();
  });

  it("collapses ten approvals into a single publish", async () => {
    // Approving a whole batch must produce one site deploy, not ten.
    const { publish, d } = make();
    for (let i = 0; i < 10; i++) d.schedule();
    await vi.advanceTimersByTimeAsync(1000);
    expect(publish).toHaveBeenCalledOnce();
  });

  it("resets the timer on each new approval", async () => {
    const { publish, d } = make();
    d.schedule();
    await vi.advanceTimersByTimeAsync(800);
    d.schedule(); // restarts the countdown
    await vi.advanceTimersByTimeAsync(800);
    expect(publish).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(publish).toHaveBeenCalledOnce();
  });

  it("allows a fresh publish after one has fired", async () => {
    const { publish, d } = make();
    d.schedule();
    await vi.advanceTimersByTimeAsync(1000);
    d.schedule();
    await vi.advanceTimersByTimeAsync(1000);
    expect(publish).toHaveBeenCalledTimes(2);
  });

  it("retries once when the publish fails", async () => {
    const publish = vi.fn(async () => {
      throw new Error("deploy failed");
    });
    const { d } = make(publish);
    d.schedule();
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(30_000); // backoff
    expect(publish).toHaveBeenCalledTimes(2);
  });

  it("alerts after the retry also fails", async () => {
    const publish = vi.fn(async () => {
      throw new Error("deploy failed");
    });
    const onError = vi.fn(async () => {});
    const { d } = make(publish, onError);
    d.schedule();
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(onError).toHaveBeenCalledOnce();
    expect(String(onError.mock.calls[0][0])).toMatch(/deploy failed/);
  });

  it("does not alert when the retry succeeds", async () => {
    let calls = 0;
    const publish = vi.fn(async () => {
      if (++calls === 1) throw new Error("transient");
    });
    const onError = vi.fn(async () => {});
    const { d } = make(publish, onError);
    d.schedule();
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(onError).not.toHaveBeenCalled();
  });

  it("publishes immediately on flushNow", async () => {
    const { publish, d } = make();
    d.schedule();
    await d.flushNow();
    expect(publish).toHaveBeenCalledOnce();
  });

  it("cancels the pending timer when flushed, so it fires only once", async () => {
    const { publish, d } = make();
    d.schedule();
    await d.flushNow();
    await vi.advanceTimersByTimeAsync(5000);
    expect(publish).toHaveBeenCalledOnce();
  });

  it("flushNow is a no-op when nothing is pending", async () => {
    const { publish, d } = make();
    await d.flushNow();
    expect(publish).not.toHaveBeenCalled();
  });

  it("reports whether a publish is pending", async () => {
    const { d } = make();
    expect(d.isPending()).toBe(false);
    d.schedule();
    expect(d.isPending()).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(d.isPending()).toBe(false);
  });

  it("cancel discards a pending publish", async () => {
    const { publish, d } = make();
    d.schedule();
    d.cancel();
    await vi.advanceTimersByTimeAsync(5000);
    expect(publish).not.toHaveBeenCalled();
  });
});
