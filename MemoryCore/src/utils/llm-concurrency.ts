/**
 * 进程级 LLM 并发信号量（按厂商 baseUrl 分桶共享）。
 *
 * 背景（2026-10-13 事故）：L1 抽取池、L1 去重、L2 场景定时任务、L3 画像各自
 * 独立发起厂商 LLM 调用，进程内没有统一闸门；慢端点挂起的调用与新调用叠加后
 * 被厂商以 `concurrency reached, current: 6, limit: 5` 秒拒，死信堆积。任务级
 * worker.concurrency（默认 60）粒度太粗且与会话锁排队纠缠，闸门放在调用漏斗
 * （StandaloneLLMRunner.run）才能精确约束厂商可见并发。
 *
 * 设计：
 *   - key = `llm:${baseUrl}`：并发限额属于厂商端点，同端点跨 runner 实例共享一桶
 *   - 默认不限（maxConcurrency 未配置或 ≤0），上游与既有部署行为不变
 *   - 槽位同步移交：释放时若有等待者则把槽位当场转交（active 不减），无等待者
 *     才真正归还 —— 唤醒不经过异步间隙，释放与新调用同拍交错也不会超限
 */

export interface SharedLlmSemaphore {
  readonly limit: number;
  run<T>(fn: () => Promise<T>): Promise<T>;
}

class SharedLlmSemaphoreImpl implements SharedLlmSemaphore {
  readonly limit: number;
  private active = 0;
  private waiters: Array<() => void> = [];

  constructor(limit: number) {
    if (!Number.isFinite(limit) || limit < 1 || !Number.isInteger(limit)) {
      throw new Error(`[llm-concurrency] limit 必须为 ≥1 的整数，收到 ${limit}`);
    }
    this.limit = limit;
  }

  run<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const release = () => {
        const next = this.waiters.shift();
        if (next) next(); // 槽位同步移交：active 保持不变，等待者当场起跑
        else this.active--;
      };
      const start = () => {
        fn().then(resolve, reject).finally(release);
      };
      if (this.active < this.limit) {
        this.active++;
        start();
      } else {
        this.waiters.push(start);
      }
    });
  }
}

const registry = new Map<string, SharedLlmSemaphoreImpl>();

/** 取（或创建）按 key 共享的信号量；同 key 恒返回同一实例。limit<1 抛错。 */
export function getSharedLlmSemaphore(key: string, limit: number): SharedLlmSemaphore {
  const existing = registry.get(key);
  if (existing) return existing;
  const created = new SharedLlmSemaphoreImpl(limit);
  registry.set(key, created);
  return created;
}

/**
 * 在 key 对应的共享闸门内执行 fn。limit ≤ 0 时直通（不限流）。
 * fn 抛错时槽位照常释放（finally），错误原样上抛。
 */
export async function withSharedLlmLimit<T>(
  key: string,
  limit: number,
  fn: () => Promise<T>,
): Promise<T> {
  if (!(limit >= 1)) return fn();
  return getSharedLlmSemaphore(key, limit).run(fn);
}
