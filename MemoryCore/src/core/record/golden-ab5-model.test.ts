/**
 * 票 07（2026-10-24 判定层 M2 治理二轮 · 第一票）单测：harness 换判定模型旋钮。
 *
 * 覆盖（票面验收「参数解析含非法 provider 报错、opencode config 组装三件套、
 * resumeKey 扩展、旧行回落」）：
 * - parseAb5ModelKnobs：--model / --provider 两参数解析 + 缺省值（openai + 空
 *   model=yaml 值占位）+ 非法 provider 显式报错（列合法值）+ 空 --model 报错。
 * - resolveAb5ModelKnobs：raw 旋钮 + yaml 全局 model → 实际生效 model（openai
 *   缺省回落 yaml 值；opencode 缺省回落预设默认模型）。
 * - providerLlmPatch：opencode 预设三件套组装（baseUrl 换预设 / apiKey 只取
 *   env TDAI_KEY_OPENCODE（缺失即抛错、不盲跑）/ x-opencode-session 随机会话头）；
 *   openai = yaml 值原样（baseUrl/apiKey/headers 透传 + model 覆盖）。
 * - 预设常量防漂移：对齐 tdai-panel vendorCatalog.ts 的 opencode-go 条目。
 * - resumeKey 扩展：四参形态键含 provider/model；两参/三参旧形态保持（既有
 *   调用不回归）；resumeSkip 按模型旋钮区分（同 pid 同 mode 异模型不误跳）。
 * - rowModelKnobs：旧行缺 model/provider 字段逐字段回落默认（openai + yaml
 *   model），旧行键 === 默认运行任务键（--resume 对历史行兼容）。
 * 样本全部合成内容，零真实 PII；本文件不发起任何网络调用、不读真实 env
 * （env 一律测试内注入，key 为合成占位值）。
 */
import { describe, it, expect } from "vitest";

import {
  AB5_PROVIDER_PRESETS,
  isAb5ProviderName,
  parseAb5ModelKnobs,
  providerLlmPatch,
  resolveAb5ModelKnobs,
} from "./golden-ab5-knobs.js";
import {
  AB5_DEFAULT_KNOBS,
  AB5_DEFAULT_PROVIDER,
  modelKnobKey,
  resumeKey,
  resumeSkip,
  rowModelKnobs,
  runExitCode,
  type Ab5Knobs,
  type Ab5ModelKnobs,
  type Ab5Row,
} from "./golden-ab5-metrics.js";

// ── 合成样本（零真实凭据；env 注入也用占位 key）────────────────────────

const YAML_LLM = {
  baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
  apiKey: "sk-test-zhipu-placeholder",
  model: "glm-5.3-flash",
} as const;

const OPENCODE_ENV = { TDAI_KEY_OPENCODE: "sk-test-opencode-placeholder" };

// ── parseAb5ModelKnobs：两参数解析 + 缺省 + 非法值报错 ───────────────────

describe("parseAb5ModelKnobs", () => {
  it("缺省：无参数 → provider=openai（=现状）、model 空串（yaml 值占位）", () => {
    expect(parseAb5ModelKnobs(["node", "golden-ab5.ts"])).toEqual({ provider: "openai", model: "" });
  });

  it("无关参数不干扰解析（含既有消融旋钮）", () => {
    expect(parseAb5ModelKnobs(["--limit=5", "--resume", "--topk=3", "--thinking=low"])).toEqual({
      provider: "openai",
      model: "",
    });
  });

  it("--model=<id> 透传解析（model 与 provider 相互独立）", () => {
    expect(parseAb5ModelKnobs(["--model=glm-5.3"])).toEqual({ provider: "openai", model: "glm-5.3" });
  });

  it("--provider=opencode 透传解析", () => {
    expect(parseAb5ModelKnobs(["--provider=opencode"])).toEqual({ provider: "opencode", model: "" });
  });

  it("--provider=opencode 与 --model 可叠加", () => {
    expect(parseAb5ModelKnobs(["--provider=opencode", "--model=deepseek-v4.1-flash"])).toEqual({
      provider: "opencode",
      model: "deepseek-v4.1-flash",
    });
  });

  it("非法 --provider 显式报错并列出合法值（openai/opencode）", () => {
    for (const bad of ["zhipu", "OPENAI", "deepseek", ""]) {
      expect(() => parseAb5ModelKnobs([`--provider=${bad}`]), `--provider=${bad}`).toThrow(/provider/);
      expect(() => parseAb5ModelKnobs([`--provider=${bad}`]), `--provider=${bad}`).toThrow(/openai/);
      expect(() => parseAb5ModelKnobs([`--provider=${bad}`]), `--provider=${bad}`).toThrow(/opencode/);
    }
  });

  it("空 --model= 显式报错（空模型名无意义，不许静默回落）", () => {
    expect(() => parseAb5ModelKnobs(["--model="])).toThrow(/model/);
  });

  it("isAb5ProviderName：openai/opencode 合法，其余（含空串）非法", () => {
    expect(isAb5ProviderName("openai")).toBe(true);
    expect(isAb5ProviderName("opencode")).toBe(true);
    expect(isAb5ProviderName("zhipu")).toBe(false);
    expect(isAb5ProviderName("")).toBe(false);
  });
});

// ── resolveAb5ModelKnobs：raw 旋钮 + yaml model → 生效 model ────────────

describe("resolveAb5ModelKnobs", () => {
  it("openai 缺省 → yaml 全局 model 原样（现状不变）", () => {
    expect(resolveAb5ModelKnobs({ provider: "openai", model: "" }, YAML_LLM.model)).toEqual({
      provider: "openai",
      model: "glm-5.3-flash",
    });
  });

  it("openai + --model=glm-5.3 → 覆盖 yaml 值（E 臂形态）", () => {
    expect(resolveAb5ModelKnobs({ provider: "openai", model: "glm-5.3" }, YAML_LLM.model)).toEqual({
      provider: "openai",
      model: "glm-5.3",
    });
  });

  it("opencode 缺省 → 预设默认模型 deepseek-v4.1-flash（yaml 模型名不跨厂商沿用）", () => {
    expect(resolveAb5ModelKnobs({ provider: "opencode", model: "" }, YAML_LLM.model)).toEqual({
      provider: "opencode",
      model: "deepseek-v4.1-flash",
    });
  });

  it("opencode + --model 显式覆盖预设默认（D 臂形态）", () => {
    expect(resolveAb5ModelKnobs({ provider: "opencode", model: "deepseek-v4-flash" }, YAML_LLM.model)).toEqual({
      provider: "opencode",
      model: "deepseek-v4-flash",
    });
  });

  it("防御：绕过解析手拼的非法 provider 显式抛错（不许静默当 openai 跑）", () => {
    expect(() => resolveAb5ModelKnobs({ provider: "zhipu", model: "" } as Ab5ModelKnobs, YAML_LLM.model)).toThrow(
      /provider/,
    );
  });
});

// ── 预设常量防漂移（对齐 tdai-panel vendorCatalog.ts opencode-go 条目）────

describe("AB5_PROVIDER_PRESETS（opencode-go 条目防漂移）", () => {
  it("baseUrl / apiKeyEnv / defaultModel / sessionHeader 与 vendorCatalog 一致", () => {
    expect(AB5_PROVIDER_PRESETS.opencode).toMatchObject({
      baseUrl: "https://opencode.ai/zen/go/v1",
      apiKeyEnv: "TDAI_KEY_OPENCODE",
      defaultModel: "deepseek-v4.1-flash",
      sessionHeader: "x-opencode-session",
    });
  });
});

// ── providerLlmPatch：runner config 组装（三件套）───────────────────────

describe("providerLlmPatch", () => {
  it("openai：baseUrl/apiKey/headers 全套 yaml 原样 + model 生效值（现状兼容）", () => {
    const llm = { ...YAML_LLM, headers: { "x-custom": "keep" } };
    const mk: Ab5ModelKnobs = { provider: "openai", model: "glm-5.3-flash" };
    expect(providerLlmPatch(llm, mk, { env: OPENCODE_ENV })).toEqual({
      baseUrl: YAML_LLM.baseUrl,
      apiKey: YAML_LLM.apiKey,
      model: "glm-5.3-flash",
      headers: { "x-custom": "keep" },
    });
  });

  it("openai 无 yaml headers → 不产出 headers 键（与现状一致，不发额外头）", () => {
    const out = providerLlmPatch(YAML_LLM, { provider: "openai", model: "glm-5.3" }, { env: OPENCODE_ENV });
    expect(out.baseUrl).toBe(YAML_LLM.baseUrl);
    expect(out.apiKey).toBe(YAML_LLM.apiKey);
    expect(out.model).toBe("glm-5.3");
    expect("headers" in out).toBe(false);
  });

  it("opencode：baseUrl 换预设 + apiKey 只取 env TDAI_KEY_OPENCODE + session 头（三件套）", () => {
    const out = providerLlmPatch(
      YAML_LLM,
      { provider: "opencode", model: "deepseek-v4.1-flash" },
      { env: OPENCODE_ENV, sessionId: "11111111-2222-3333-4444-555555555555" },
    );
    expect(out.baseUrl).toBe("https://opencode.ai/zen/go/v1");
    expect(out.apiKey).toBe("sk-test-opencode-placeholder");
    expect(out.model).toBe("deepseek-v4.1-flash");
    expect(out.headers).toEqual({ "x-opencode-session": "11111111-2222-3333-4444-555555555555" });
  });

  it("opencode：env 缺失 → 显式抛错点名 env 名（不盲跑；错误信息只有变量名无 key 值）", () => {
    try {
      providerLlmPatch(YAML_LLM, { provider: "opencode", model: "deepseek-v4.1-flash" }, { env: {} });
      expect.unreachable("opencode 无 key 应抛错");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      expect(msg).toContain("TDAI_KEY_OPENCODE");
      expect(msg).not.toContain("sk-test");
    }
  });

  it("opencode：env 值为空串同样视为缺失（空 key 必然 401，等价没配）", () => {
    expect(() =>
      providerLlmPatch(YAML_LLM, { provider: "opencode", model: "deepseek-v4.1-flash" }, { env: { TDAI_KEY_OPENCODE: "" } }),
    ).toThrow(/TDAI_KEY_OPENCODE/);
  });

  it("opencode：session 头随运行随机（两次组装不同值、均 UUID 形）", () => {
    const a = providerLlmPatch(YAML_LLM, { provider: "opencode", model: "deepseek-v4.1-flash" }, { env: OPENCODE_ENV });
    const b = providerLlmPatch(YAML_LLM, { provider: "opencode", model: "deepseek-v4.1-flash" }, { env: OPENCODE_ENV });
    const sa = a.headers?.["x-opencode-session"];
    const sb = b.headers?.["x-opencode-session"];
    expect(sa).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(sb).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(sa).not.toBe(sb);
  });

  it("openai：不读 TDAI_KEY_OPENCODE（yaml key 原样，key 只按 provider 对应来源取）", () => {
    const out = providerLlmPatch(YAML_LLM, { provider: "openai", model: "glm-5.3-flash" }, { env: OPENCODE_ENV });
    expect(out.apiKey).toBe(YAML_LLM.apiKey);
  });
});

// ── resumeKey / resumeSkip 模型旋钮扩展 ─────────────────────────────────

describe("resumeKey / resumeSkip 模型旋钮扩展", () => {
  const knobs: Ab5Knobs = { topk: 5, thinking: "", promptVariant: "base" };
  const openaiMk: Ab5ModelKnobs = { provider: "openai", model: "glm-5.3-flash" };

  it("两参旧形态保持不变（既有调用不回归）", () => {
    expect(resumeKey("g001", "none")).toBe("g001|none");
  });

  it("三参形态保持不变（票 05 键格式不动）", () => {
    expect(resumeKey("g001", "none", knobs)).toBe("g001|none|topk=5|thinking=none|variant=base");
  });

  it("四参形态：键尾追加 provider/model（模型旋钮进跳过键）", () => {
    expect(resumeKey("g001", "none", knobs, openaiMk)).toBe(
      "g001|none|topk=5|thinking=none|variant=base|provider=openai|model=glm-5.3-flash",
    );
    expect(resumeKey("g001", "none", knobs, { provider: "opencode", model: "deepseek-v4.1-flash" })).toBe(
      "g001|none|topk=5|thinking=none|variant=base|provider=opencode|model=deepseek-v4.1-flash",
    );
  });

  it("modelKnobKey：聚合分组键的模型段（与 resumeKey 后缀一致）", () => {
    expect(modelKnobKey(openaiMk)).toBe("provider=openai|model=glm-5.3-flash");
    expect(resumeKey("p", "none", knobs, openaiMk)).toBe(`p|none|${"topk=5|thinking=none|variant=base"}|${modelKnobKey(openaiMk)}`);
  });

  it("resumeSkip：任务带模型旋钮按扩展键跳过（同 pid 同 mode 异模型不误跳）", () => {
    const mk = (m: Ab5ModelKnobs): { pid: string; mode: string; knobs: Ab5Knobs; modelKnobs: Ab5ModelKnobs } => ({
      pid: "p1",
      mode: "none",
      knobs,
      modelKnobs: m,
    });
    const judged = new Set([resumeKey("p1", "none", knobs, openaiMk)]);
    const r = resumeSkip(judged, [mk(openaiMk), mk({ provider: "opencode", model: "deepseek-v4.1-flash" })]);
    expect(r.skipped).toBe(1);
    expect(r.pending).toEqual([mk({ provider: "opencode", model: "deepseek-v4.1-flash" })]);
  });

  it("resumeSkip：任务不带模型旋钮 → 沿用票 05 键（既有行为）", () => {
    const tasks = [{ pid: "p1", mode: "none", knobs }];
    const judged = new Set([resumeKey("p1", "none", knobs)]);
    expect(resumeSkip(judged, tasks)).toEqual({ pending: [], skipped: 1 });
  });
});

// ── rowModelKnobs：旧行回落 ─────────────────────────────────────────────

describe("rowModelKnobs", () => {
  const defaults: Ab5ModelKnobs = { provider: AB5_DEFAULT_PROVIDER, model: "glm-5.3-flash" };

  it("行含新字段 → 原样归一", () => {
    expect(rowModelKnobs({ provider: "opencode", model: "deepseek-v4.1-flash" }, defaults)).toEqual({
      provider: "opencode",
      model: "deepseek-v4.1-flash",
    });
  });

  it("旧行（票 05/02 时代，无 model/provider 字段）→ 回落默认（openai + yaml model）", () => {
    expect(rowModelKnobs({}, defaults)).toEqual({ provider: "openai", model: "glm-5.3-flash" });
    expect(rowModelKnobs({ topk: 5, thinking: "", promptVariant: "base" }, defaults)).toEqual(defaults);
  });

  it("部分字段缺失 → 逐字段回落（provider 在而 model 缺，反之亦然）", () => {
    expect(rowModelKnobs({ provider: "opencode" }, defaults)).toEqual({ provider: "opencode", model: "glm-5.3-flash" });
    expect(rowModelKnobs({ model: "glm-5.3" }, defaults)).toEqual({ provider: "openai", model: "glm-5.3" });
  });

  it("旧行归一键 === 默认运行任务键（同一次默认 --resume 可无缝续跑历史行）", () => {
    const oldRow = { pid: "p1", mode: "none", topk: 5, thinking: "", promptVariant: "base" };
    expect(resumeKey(oldRow.pid, oldRow.mode, AB5_DEFAULT_KNOBS, rowModelKnobs(oldRow, defaults))).toBe(
      resumeKey("p1", "none", AB5_DEFAULT_KNOBS, defaults),
    );
  });

  it("旧行键 ≠ 换模型运行键（--model=glm-5.3 不误吞历史 yaml 模型行）", () => {
    const oldRow = { pid: "p1", mode: "none" };
    const runMk: Ab5ModelKnobs = { provider: "openai", model: "glm-5.3" };
    expect(resumeKey("p1", "none", AB5_DEFAULT_KNOBS, rowModelKnobs(oldRow, defaults))).not.toBe(
      resumeKey("p1", "none", AB5_DEFAULT_KNOBS, runMk),
    );
  });
});

// ── runExitCode：本轮跑批失败退出码（票 07 双审 P1）─────────────────────

describe("runExitCode", () => {
  const row = (action: string): Ab5Row => ({
    pid: "p1",
    mode: "none",
    golden: "store",
    action,
    sim: null,
    band: "neg",
    twin_source: "db",
    twin_rank: null,
  });

  it("本轮 fresh 含 error 行 → 非零（1）——鉴权失败等探针/跑批失败不得 exit 0", () => {
    expect(runExitCode([row("error"), row("store")], false)).toBe(1);
    expect(runExitCode([row("error"), row("error")], true)).toBe(1);
  });

  it("本轮 fresh 无 error 行 → 0（历史 error 行不经 fresh 传入不算；degraded=true 全文件口径兜底为 1）", () => {
    expect(runExitCode([row("store"), row("merge")], false)).toBe(0);
    expect(runExitCode([], false)).toBe(0);
    expect(runExitCode([row("store")], true)).toBe(1);
  });
});
