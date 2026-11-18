import { describe, expect, it, vi } from "vitest";
import { DecisionProviderError } from "../decision/types.js";
import type { PersistedSceneDiff, SceneFileSnapshot } from "../scene/scene-extractor.js";
import type { StorageAdapter } from "../storage/adapter.js";
import type { MemoryTdaiConfig } from "../../config.js";
import {
  JEV_CRITERIA,
  JEV_INSTRUCTIONS,
  evaluateL3JevGate,
  JevGateAnswerError,
  classifyJevFailure,
  endpointHost,
  isChangeType,
  l2ChangedNames,
  redactKnownSecret,
  sha256,
  summarizeSceneDiff,
  summarizeSnapshot,
  throwIfAborted,
} from "./jev-gate.js";

// 合成低熵模式串：仅用于脱敏断言，禁真实凭据形态。
const SYNTHETIC_SECRET = "AX7Q-TESTTOKEN-0001";

function snap(filename: string, over: Partial<SceneFileSnapshot> = {}): SceneFileSnapshot {
  return {
    filename,
    sha256: `hash-${filename}`,
    chars: 120,
    parseable: true,
    created: "2026-11-18T00:00:00.000Z",
    updated: "2026-11-18T01:00:00.000Z",
    summary: "scene summary (must be stripped)",
    heat: 3,
    content: "scene content (must be stripped)",
    raw: "scene raw (must be stripped)",
    ...over,
  };
}

function emptyDiff(): PersistedSceneDiff {
  return { beforeFiles: [], afterFiles: [], created: [], updated: [], deleted: [] };
}

describe("jev-gate · A 组：isChangeType 白名单与原型链鲁棒", () => {
  it("五个合法标签全 true", () => {
    for (const key of ["conflict", "boundary_change", "new_rule", "reinforcement", "none"] as const) {
      expect(isChangeType(key), key).toBe(true);
      expect(JEV_CRITERIA[key]).toBeTypeOf("string");
    }
  });

  it("原型链键与空串全 false（hasOwnProperty 白名单不得被绕过）", () => {
    for (const key of ["toString", "constructor", "__proto__", "hasOwnProperty", "valueOf", ""]) {
      expect(isChangeType(key), key).toBe(false);
    }
  });
});

describe("jev-gate · B 组：redactKnownSecret 递归脱敏与零回显", () => {
  it("标量字符串中的 secret 子串被替换", () => {
    const out = redactKnownSecret(`prefix-${SYNTHETIC_SECRET}-suffix`, SYNTHETIC_SECRET);
    expect(out).toBe("prefix-[REDACTED]-suffix");
    expect(JSON.stringify(out)).not.toContain(SYNTHETIC_SECRET);
  });

  it("数组与嵌套对象的每一层都被脱敏", () => {
    const input = {
      top: SYNTHETIC_SECRET,
      list: [SYNTHETIC_SECRET, { deep: `x${SYNTHETIC_SECRET}y` }],
      untouched: 42,
    };
    const out = redactKnownSecret(input, SYNTHETIC_SECRET) as Record<string, unknown>;
    expect(out.top).toBe("[REDACTED]");
    expect((out.list as unknown[])[0]).toBe("[REDACTED]");
    expect(((out.list as unknown[])[1] as Record<string, unknown>).deep).toBe("x[REDACTED]y");
    expect(out.untouched).toBe(42);
    expect(JSON.stringify(out)).not.toContain(SYNTHETIC_SECRET);
  });

  it("空 secret 原样返回；数字/null/布尔原样穿透", () => {
    const fixture = { k: SYNTHETIC_SECRET, n: 7, z: null, b: false };
    expect(redactKnownSecret(fixture, "")).toBe(fixture);
    const out = redactKnownSecret(fixture, SYNTHETIC_SECRET) as Record<string, unknown>;
    expect(out.n).toBe(7);
    expect(out.z).toBeNull();
    expect(out.b).toBe(false);
  });
});

describe("jev-gate · C 组：classifyJevFailure 八类精确分类", () => {
  it("JevGateAnswerError 透传 reason", () => {
    expect(classifyJevFailure(new JevGateAnswerError("missing_answer", "x"))).toBe("missing_answer");
    expect(classifyJevFailure(new JevGateAnswerError("invalid_choice", "x"))).toBe("invalid_choice");
  });

  it("非 2xx HTTP status → http_<status>", () => {
    expect(classifyJevFailure(new Error("boom"), 404)).toBe("http_404");
    expect(classifyJevFailure(new Error("boom"), 503)).toBe("http_503");
  });

  it("DecisionProviderError 按 reason/status 分类", () => {
    expect(classifyJevFailure(new DecisionProviderError("http_error", "x", 429))).toBe("http_429");
    expect(classifyJevFailure(new DecisionProviderError("fetch_failed", "x"))).toBe("fetch_failed");
    expect(classifyJevFailure(new DecisionProviderError("invalid_config", "x"))).toBe("invalid_config");
  });

  it("消息粗分类四形态", () => {
    expect(classifyJevFailure(new Error("response was non-JSON"))).toBe("non_json");
    expect(classifyJevFailure(new Error("missing `answers` field"))).toBe("invalid_response");
    expect(classifyJevFailure(new Error("unexpected response shape"))).toBe("invalid_response");
    expect(classifyJevFailure(new Error("fetch failed"))).toBe("fetch_failed");
    expect(classifyJevFailure(new Error("not configured"))).toBe("invalid_config");
    expect(classifyJevFailure(new Error("invalid endpoint"))).toBe("invalid_config");
    expect(classifyJevFailure(new Error("must be https"))).toBe("invalid_config");
  });

  it("未知错误 → jev_error 兜底", () => {
    expect(classifyJevFailure(new Error("totally unknown"))).toBe("jev_error");
    expect(classifyJevFailure("plain string error")).toBe("jev_error");
  });
});

describe("jev-gate · D 组：endpointHost / throwIfAborted / sha256", () => {
  it("endpointHost 取 hostname，非法 URL → invalid", () => {
    expect(endpointHost("https://api.example.com:8443/v1/chat")).toBe("api.example.com");
    expect(endpointHost("http://localhost:8420/health")).toBe("localhost");
    expect(endpointHost("not a url")).toBe("invalid");
    expect(endpointHost("")).toBe("invalid");
  });

  it("throwIfAborted：未 aborted 无动作，带 reason 保真重抛，无 reason 泛型兜底", () => {
    expect(() => throwIfAborted(undefined)).not.toThrow();
    expect(() => throwIfAborted(new AbortController().signal)).not.toThrow();

    const reason = new Error("user cancelled");
    const ctrl = new AbortController();
    ctrl.abort(reason);
    try {
      throwIfAborted(ctrl.signal);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBe(reason);
    }

    const ctrl2 = new AbortController();
    // 非 Error reason 才触发泛型兜底；无参 abort() 的 reason 是 DOMException(Error) 会走保真重抛分支。
    ctrl2.abort("string reason");
    expect(() => throwIfAborted(ctrl2.signal)).toThrow("L3 task aborted");
  });

  it("sha256 已知向量 + 空串 + 确定性", () => {
    expect(sha256("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256("repeat")).toBe(sha256("repeat"));
  });
});

describe("jev-gate · E 组：summarizeSceneDiff / summarizeSnapshot / l2ChangedNames", () => {
  it("summarizeSnapshot 只留诊断字段，剥离 summary/content/raw", () => {
    const out = summarizeSnapshot(snap("A.md"));
    expect(out).toEqual({
      filename: "A.md",
      sha256: "hash-A.md",
      chars: 120,
      parseable: true,
      created: "2026-11-18T00:00:00.000Z",
      updated: "2026-11-18T01:00:00.000Z",
      heat: 3,
    });
    expect(JSON.stringify(out)).not.toContain("scene content");
  });

  it("summarizeSceneDiff 逐段映射，空 diff 全空", () => {
    const diff: PersistedSceneDiff = {
      beforeFiles: ["B.md", "A.md"],
      afterFiles: ["A.md", "C.md"],
      created: [snap("C.md")],
      updated: [{ before: snap("A.md"), after: snap("A.md", { chars: 200 }) }],
      deleted: [snap("B.md")],
    };
    const out = summarizeSceneDiff(diff);
    expect(out.before_files).toEqual(["B.md", "A.md"]);
    expect(out.after_files).toEqual(["A.md", "C.md"]);
    expect(out.created.map((s) => s.filename)).toEqual(["C.md"]);
    expect(out.updated[0]!.after.chars).toBe(200);
    expect(out.deleted.map((s) => s.filename)).toEqual(["B.md"]);
    expect(summarizeSceneDiff(emptyDiff())).toEqual({
      before_files: [], after_files: [], created: [], updated: [], deleted: [],
    });
  });

  it("l2ChangedNames 汇总 created + updated.after 并排序，空 diff → []", () => {
    const diff: PersistedSceneDiff = {
      ...emptyDiff(),
      created: [snap("C.md")],
      updated: [{ before: snap("A.md"), after: snap("A.md") }],
      deleted: [snap("B.md")],
    };
    expect(l2ChangedNames(summarizeSceneDiff(diff))).toEqual(["A.md", "C.md"]);
    expect(l2ChangedNames(undefined)).toEqual([]);
  });
});

describe("jev-gate · F 组：集成 seam（注入 storage / 提示词优先级契约）", () => {
  it("注入的 storage.readFile 被使用：读失败 → unavailable/input_read_failed、called=false（证明走注入 seam 而非 fs）", async () => {
    const readFile = vi.fn().mockRejectedValue(new Error("injected storage boom"));
    const storage = { readFile, getBackend: () => ({ type: "memory" }) } as unknown as StorageAdapter;
    const cfg = { persona: { jev: { diagnostics: { mode: "off" } } } } as unknown as MemoryTdaiConfig;
    const logger = { info: () => {}, warn: () => {}, error: () => {} };

    const result = await evaluateL3JevGate({
      dataDir: "__never_touched_fs__",
      cfg,
      logger,
      storage,
      triggerReason: "test",
    });

    expect(result.kind).toBe("unavailable");
    expect(result.reason).toBe("input_read_failed");
    expect(result.called).toBe(false);
    expect(result.shouldGenerate).toBe(false);
    expect(readFile).toHaveBeenCalled();
  });

  it("优先级契约钉在提示词：conflict > boundary_change > new_rule > reinforcement > none，且禁止复数票否决", () => {
    const order = ["conflict", "boundary_change", "new_rule", "reinforcement", "none"];
    const positions = order.map((label) => JEV_INSTRUCTIONS.indexOf(label));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(JEV_INSTRUCTIONS).toContain("Never let reinforcing or irrelevant scenes outvote");
    expect(JEV_INSTRUCTIONS).toContain("Priority is conflict > boundary_change > new_rule > reinforcement > none");
    // 五个标签与 JEV_CRITERIA 白名单一一对应，提示词/enum 不漂移。
    expect(Object.keys(JEV_CRITERIA)).toEqual(order);
  });
});
