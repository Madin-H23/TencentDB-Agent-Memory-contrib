// checkpoint rename 瞬态重试的单测（闸门加固配套，2026-10-24）。
// 背景：l2-batch「同毫秒兄弟不丢」用例 flaky（连跑 5 次挂 1，20%）——writeRaw 的
// rename(tmp, filePath) 在 Windows 上会被杀毒/索引服务瞬时握住目标句柄 → EPERM；
// 进程内 withFileLock 只串行自家临界区，防不了系统级瞬态占用。修复 = rename 对
// EPERM/EBUSY 做短退避重试（renameWithRetry，fs 模块注入便于直测）。本文件锁三个契约：
//   ① 首次 EPERM → 退避重试后成功（rename 共调用 2 次）；
//   ② 非瞬态错误（ENOENT 等）→ 立即上抛不重试；
//   ③ 重试耗尽仍 EPERM → 上抛最后一次错误（默认 4 次尝试）。
import { describe, it, expect } from "vitest";

const { renameWithRetry } = await import("./checkpoint.js");

function eperm(): NodeJS.ErrnoException {
  const e = new Error("EPERM: operation not permitted, rename") as NodeJS.ErrnoException;
  e.code = "EPERM";
  return e;
}

function enoent(): NodeJS.ErrnoException {
  const e = new Error("ENOENT: no such file or directory, rename") as NodeJS.ErrnoException;
  e.code = "ENOENT";
  return e;
}

/** fs 注入桩：按脚本行为依次执行，记录每次 rename 调用。 */
function fakeFs(behavior: Array<() => void>, calls: Array<[string, string]>) {
  return {
    rename: async (from: string, to: string) => {
      calls.push([from, to]);
      const step = behavior.shift();
      if (step) step();
    },
  };
}

describe("checkpoint renameWithRetry（Windows 瞬态占用加固）", () => {
  it("① 首次 EPERM → 退避重试后成功，rename 共调用 2 次", async () => {
    const calls: Array<[string, string]> = [];
    await renameWithRetry(fakeFs([() => { throw eperm(); }], calls) as never, "a.tmp", "a.json");
    expect(calls.length).toBe(2);
    expect(calls[0]).toEqual(["a.tmp", "a.json"]);
    expect(calls[1]).toEqual(["a.tmp", "a.json"]);
  });

  it("② 非瞬态错误（ENOENT）→ 立即上抛不重试", async () => {
    const calls: Array<[string, string]> = [];
    await expect(
      renameWithRetry(fakeFs([() => { throw enoent(); }], calls) as never, "a.tmp", "a.json"),
    ).rejects.toThrow(/ENOENT/);
    expect(calls.length).toBe(1);
  });

  it("③ 连续 EPERM 耗尽默认 4 次尝试 → 上抛最后一次错误", async () => {
    const calls: Array<[string, string]> = [];
    const behavior = [0, 1, 2, 3].map(() => () => { throw eperm(); });
    await expect(
      renameWithRetry(fakeFs(behavior, calls) as never, "a.tmp", "a.json"),
    ).rejects.toThrow(/EPERM/);
    expect(calls.length).toBe(4);
  });
});
