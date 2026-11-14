// 票 origin#28（S1·L0 明文凭据三件套——写入侧掩码）：凭据掩码纯函数。
// 缺陷实证（2026-11-05）：2026-10-09 一条 sk- 前缀 API Key 明文被 auto-capture
// 落库，面板 L0 视图原样渲染、检索上下文再带出（二次暴露面）。commit 侧凭据闸
// 已拦 git 面，数据面是系统性缺口——本模块在 L0 写入前掩码（默认 off）。
// 拒绝式解析对齐 parseParkedBackoffConfig / parseSemanticGateConfig 先例。
import { describe, expect, it } from "vitest";
import {
  maskCredentials,
  parseCredentialMaskConfig,
  createCredentialMasker,
} from "./credential-mask.js";

describe("maskCredentials：内置模式（sk- / Bearer）", () => {
  it("sk- + 20 位字母数字 → 掩码（保留前缀，SiliconFlow/智谱/DeepSeek 形态）", () => {
    const text = "我的 key 是 sk-abcdefghij0123456789 请查收";
    expect(maskCredentials(text)).toBe("我的 key 是 sk-***masked*** 请查收");
  });

  it("sk- + 恰 20 位为命中边界；19 位不命中", () => {
    expect(maskCredentials("sk-abcdefghij0123456789")).toBe("sk-***masked***");
    expect(maskCredentials("sk-abcdefghij012345678")).toBe("sk-abcdefghij012345678"); // 19 位
  });

  it("sk-proj- 二段形态命中（OpenAI 形态·第二段 ≥24 位）；23 位不命中", () => {
    expect(maskCredentials("sk-proj-AbCdEf0123456789AbCdEfGh")).toBe("sk-***masked***");
    expect(maskCredentials("sk-proj-AbCdEf0123456789AbCdEf")).toBe("sk-proj-AbCdEf0123456789AbCdEf");
  });

  it("Bearer <token> 形态 → 掩码（HTTP Authorization·fixture 用占位 x 串过凭据闸）", () => {
    expect(maskCredentials("hdr: Bearer xxxxxxxxxxxxxxxx")).toBe(
      "hdr: Bearer ***masked***",
    );
    expect(maskCredentials("Bearer xxxxxxxxxxxxx")).toBe("Bearer xxxxxxxxxxxxx"); // 15 位不命中
  });

  it("同条多 key 全掩（全局替换）", () => {
    const text = "a=sk-abcdefghij0123456789 b=sk-0123456789abcdefghij";
    const out = maskCredentials(text);
    expect(out).toBe("a=sk-***masked*** b=sk-***masked***");
    expect(out.includes("abcdefghij0123456789")).toBe(false);
  });

  it("中文混排/引号内/行首均命中", () => {
    expect(maskCredentials('apiKey: "sk-abcdefghij0123456789"')).toBe('apiKey: "sk-***masked***"');
    expect(maskCredentials("\nsk-abcdefghij0123456789\n")).toBe("\nsk-***masked***\n");
  });

  it("误伤校验：sklearn / sk-短词 / task-sk- 连字命名不掩", () => {
    expect(maskCredentials("use sklearn to fit the model")).toBe("use sklearn to fit the model");
    expect(maskCredentials("sk-learn-model-pipeline")).toBe("sk-learn-model-pipeline");
    expect(maskCredentials("task-sk-abcdefghij0123456789")).toBe("task-sk-abcdefghij0123456789"); // sk- 前是连字符（词组命名）不掩
    expect(maskCredentials("const taskIds = 42")).toBe("const taskIds = 42");
  });
});

describe("maskCredentials：自定义前缀", () => {
  it("zep_ 前缀 + 恰 16 位 → 掩码（保留自定义前缀）", () => {
    expect(maskCredentials("hdr=zep_abcdef0123456789", ["zep_"])).toBe("hdr=zep_***masked***");
  });

  it("自定义前缀 15 位不命中；未配置该前缀时不掩", () => {
    expect(maskCredentials("zep_abcdef012345678", ["zep_"])).toBe("zep_abcdef012345678");
    expect(maskCredentials("zep_abcdef0123456789")).toBe("zep_abcdef0123456789"); // prefixes 未含
  });

  it("自定义前缀含正则元字符时按字面匹配（转义）", () => {
    expect(maskCredentials("k=abc(def)0123456789abcdef", ["abc(def)"])).toBe("k=abc(def)***masked***");
  });
});

describe("parseCredentialMaskConfig：拒绝式解析", () => {
  it("undefined/null/false → undefined（off=现有行为逐字节不变）", () => {
    expect(parseCredentialMaskConfig(undefined)).toBeUndefined();
    expect(parseCredentialMaskConfig(null)).toBeUndefined();
    expect(parseCredentialMaskConfig(false)).toBeUndefined();
  });

  it("true → on（内置模式）；对象透传 mode/prefixes", () => {
    expect(parseCredentialMaskConfig(true)).toEqual({ mode: "on", prefixes: [] });
    expect(parseCredentialMaskConfig({ mode: "shadow" })).toEqual({ mode: "shadow", prefixes: [] });
    expect(parseCredentialMaskConfig({ mode: "on", prefixes: ["hf_", "zep_"] })).toEqual({
      mode: "on",
      prefixes: ["hf_", "zep_"],
    });
  });

  it("畸形值 throw（不静默回落）", () => {
    expect(() => parseCredentialMaskConfig(42)).toThrow();
    expect(() => parseCredentialMaskConfig("on")).toThrow();
    expect(() => parseCredentialMaskConfig({})).toThrow(); // mode 缺失
    expect(() => parseCredentialMaskConfig({ mode: "off" })).toThrow(); // off 用 false/缺省表达
    expect(() => parseCredentialMaskConfig({ mode: "on", prefixes: [""] })).toThrow(); // 空前缀
    expect(() => parseCredentialMaskConfig({ mode: "on", prefixes: "hf_" })).toThrow(); // 非数组
  });
});

describe("createCredentialMasker：接线闭包（off=undefined·shadow 不改文只计量·on 真掩）", () => {
  it("off/缺省 → undefined（调用方不接线）", () => {
    expect(createCredentialMasker(undefined)).toBeUndefined();
    expect(createCredentialMasker(false)).toBeUndefined();
  });

  it("on → 返回掩码闭包", () => {
    const masker = createCredentialMasker({ mode: "on", prefixes: [] });
    expect(masker).toBeTypeOf("function");
    expect(masker!("k=sk-abcdefghij0123456789")).toBe("k=sk-***masked***");
  });

  it("shadow → 返回原文（逐字节不变）且打 metric 行", () => {
    const lines: string[] = [];
    const logger = { info: (m: string) => lines.push(m) } as never;
    const masker = createCredentialMasker({ mode: "shadow", prefixes: [] }, logger);
    expect(masker).toBeTypeOf("function");
    const clean = "普通消息无凭据";
    const dirty = "k=sk-abcdefghij0123456789";
    expect(masker!(clean)).toBe(clean);
    expect(masker!(dirty)).toBe(dirty); // shadow 不改文
    expect(masker!(dirty)).toBe(dirty); // 第二次命中 → 计数 2
    const metricLines = lines.filter((l) => l.includes("metric=capture_credential_mask_shadow"));
    expect(metricLines.length).toBe(2); // 每次命中打一行
    expect(metricLines[metricLines.length - 1]).toContain("hits=2");
    expect(metricLines[0]).not.toContain("sk-abcdefghij"); // metric 行不回显凭据内容
  });
});
