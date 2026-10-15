// P2 补漏（2026-10-15，v2 a583c3d 移植）：手动 L1 排空端点 /v2/pipeline/l1/trigger。
// v3 重写丢失该路由 → 面板「排空」按钮 404（网关基础层 Not found，非 v2 envelope）。
// 底层 manager.enqueueL1Drain 在 v3 仍在（executor 积压兜底同款），仅缺 HTTP 暴露。
// 目标（绿）：standalone 下入队 L1 drain 任务并回 {queued:[sessionKey]}；
// service 模式 404、缺 session_key 400、manager 缺失 503、入队抛错 500。
import { describe, it, expect, vi } from "vitest";

import { handlePipelineL1Trigger } from "./v2-router.js";
import type { V2RouterDeps } from "./v2-router.js";

const AUTH = { apiKey: "test-key", serviceId: "default" };

function makeDeps(overrides: Partial<V2RouterDeps> = {}): V2RouterDeps {
  return {
    deployMode: "standalone",
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    ...overrides,
  } as unknown as V2RouterDeps;
}

describe("handlePipelineL1Trigger：手动排空端点（v3 移植回归）", () => {
  it("service 模式 → 404 信封（与 /v2/pipeline/status 一致，不暴露路由）", async () => {
    const enqueue = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      deployMode: "service",
      getStatefulPipelineManager: () => ({ enqueueL1Drain: enqueue }) as never,
    });
    const res = await handlePipelineL1Trigger({ session_key: "zcode-default" }, AUTH, "req-1", deps);
    expect(res.code).toBe(404);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("缺 session_key → 400", async () => {
    const deps = makeDeps({ getStatefulPipelineManager: () => ({ enqueueL1Drain: vi.fn() }) as never });
    const res = await handlePipelineL1Trigger({}, AUTH, "req-2", deps);
    expect(res.code).toBe(400);
    expect(res.message).toContain("session_key");
  });

  it("session_key 非字符串/空白 → 400", async () => {
    const deps = makeDeps({ getStatefulPipelineManager: () => ({ enqueueL1Drain: vi.fn() }) as never });
    expect((await handlePipelineL1Trigger({ session_key: 42 }, AUTH, "r", deps)).code).toBe(400);
    expect((await handlePipelineL1Trigger({ session_key: "   " }, AUTH, "r", deps)).code).toBe(400);
  });

  it("manager 不可用 → 503", async () => {
    const deps = makeDeps({ getStatefulPipelineManager: () => undefined });
    const res = await handlePipelineL1Trigger({ session_key: "zcode-default" }, AUTH, "req-3", deps);
    expect(res.code).toBe(503);
  });

  it("standalone + manager → 入队并回 {queued:[sessionKey]}，带 auth.serviceId", async () => {
    const enqueue = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({ getStatefulPipelineManager: () => ({ enqueueL1Drain: enqueue }) as never });
    const res = await handlePipelineL1Trigger({ session_key: "zcode-default" }, AUTH, "req-4", deps);
    expect(res.code).toBe(0);
    expect(res.data).toEqual({ queued: ["zcode-default"] });
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith("zcode-default", "default");
  });

  it("入队抛错 → 500 信封带原因", async () => {
    const enqueue = vi.fn().mockRejectedValue(new Error("backend down"));
    const deps = makeDeps({ getStatefulPipelineManager: () => ({ enqueueL1Drain: enqueue }) as never });
    const res = await handlePipelineL1Trigger({ session_key: "zcode-default" }, AUTH, "req-5", deps);
    expect(res.code).toBe(500);
    expect(res.message).toContain("backend down");
  });
});
