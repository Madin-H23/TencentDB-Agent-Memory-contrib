/**
 * 票 09（2026-10-24 判定层 few-shot 优化变体）单测：--prompt-variant=fewshot。
 *
 * 覆盖（票面验收「变体解析、文案完整性（两示例 + strict 段均在）、非法枚举报错」）：
 * - 枚举扩展：--prompt-variant=fewshot 解析接受、isPromptVariantName、非法值
 *   报错文案同步列出 base/strict/fewshot。
 * - 组合文案完整性：fewshot 追加段 = strict 收紧段（既有常量原样）+ 空行 +
 *   「判定示例：」小节；两示例对准票 06 取证的两个失败模式（负例=同主题不同
 *   事实误合 → store；正例=同一偏好演进应合被弃 → merge）；小节字符数 ≤600。
 * - 合成性防漂移：示例特征短语与金标 fixture 正文零重叠（把票面 grep 证固化为
 *   回归测试，防未来改文案时抄进金标内容域、教模型背答案）。
 * - 注入点：withPromptVariant / variantWrappedRunner 对 fewshot 的追加与
 *   缺 systemPrompt 防护（与 strict 同一机制、同一防护）。
 * 样本全部合成内容，零真实 PII；本文件不发起任何网络调用。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

import {
  AB5_FEWSHOT_EXAMPLES,
  AB5_STRICT_PROMPT_SUFFIX,
  DEFAULT_PROMPT_VARIANT,
  PROMPT_VARIANTS,
  isPromptVariantName,
  parseAb5Knobs,
  variantWrappedRunner,
  withPromptVariant,
} from "./golden-ab5-knobs.js";
import type { LLMRunParams } from "../types.js";

/** 示例合成性核对的锚点短语（示例自身的特征片段，非金标措辞）。 */
const FEWSHOT_ANCHOR_PHRASES = [
  "用户偏好深色主题",
  "用户换了新机械键盘",
  "同属编辑器外观",
  "要求以后出差优先坐高铁",
  "确认出差交通标准固定为高铁二等座",
  "同一出行偏好的演进",
] as const;

// ── 枚举扩展：--prompt-variant=fewshot ──────────────────────────────────

describe("parseAb5Knobs fewshot 枚举（票 09）", () => {
  it("--prompt-variant=fewshot 接受", () => {
    expect(parseAb5Knobs(["--prompt-variant=fewshot"]).promptVariant).toBe("fewshot");
  });

  it("isPromptVariantName：fewshot 合法，未知名与空串仍非法", () => {
    expect(isPromptVariantName("fewshot")).toBe(true);
    expect(isPromptVariantName("base")).toBe(true);
    expect(isPromptVariantName("strict")).toBe(true);
    expect(isPromptVariantName("bogus")).toBe(false);
    expect(isPromptVariantName("")).toBe(false);
  });

  it("非法 --prompt-variant 报错文案同步列出 base/strict/fewshot", () => {
    expect(() => parseAb5Knobs(["--prompt-variant=aggro"])).toThrow(/prompt-variant/);
    expect(() => parseAb5Knobs(["--prompt-variant=aggro"])).toThrow(/fewshot/);
    expect(() => parseAb5Knobs(["--prompt-variant=aggro"])).toThrow(/strict/);
    expect(() => parseAb5Knobs(["--prompt-variant=aggro"])).toThrow(new RegExp(DEFAULT_PROMPT_VARIANT));
  });
});

// ── 组合文案完整性：strict 段 + 判定示例小节 ────────────────────────────

describe("fewshot 组合文案完整性", () => {
  it("fewshot 追加段 = strict 收紧段（既有常量原样）+ 空行 + 判定示例小节", () => {
    expect(PROMPT_VARIANTS.fewshot).toBe(`${AB5_STRICT_PROMPT_SUFFIX}\n\n${AB5_FEWSHOT_EXAMPLES}`);
  });

  it("判定示例小节含两示例，且各对准票 06 取证的一个失败模式", () => {
    expect(AB5_FEWSHOT_EXAMPLES.startsWith("判定示例：")).toBe(true);
    expect(AB5_FEWSHOT_EXAMPLES).toContain("例一");
    expect(AB5_FEWSHOT_EXAMPLES).toContain("例二");
    // 负例（同主题不同事实 → store）：编辑器外观同域、深色主题 vs 机械键盘两事实
    expect(AB5_FEWSHOT_EXAMPLES).toContain("深色主题");
    expect(AB5_FEWSHOT_EXAMPLES).toContain("机械键盘");
    expect(AB5_FEWSHOT_EXAMPLES).toContain("→ store");
    // 正例（同一偏好演进 → merge）：出差优先坐高铁 → 交通标准固定为高铁二等座
    expect(AB5_FEWSHOT_EXAMPLES).toContain("出差优先坐高铁");
    expect(AB5_FEWSHOT_EXAMPLES).toContain("高铁二等座");
    expect(AB5_FEWSHOT_EXAMPLES).toContain("→ merge");
    // strict 收紧段不在示例小节内重复（组合时才拼入，小节保持纯示例）
    expect(AB5_FEWSHOT_EXAMPLES).not.toContain(AB5_STRICT_PROMPT_SUFFIX);
  });

  it("字符数约束：示例小节 ≤600 且 fewshot 总追加段 ≤600（票面「总增量 ≤600 字符」双口径护栏）", () => {
    expect(AB5_FEWSHOT_EXAMPLES.length).toBeLessThanOrEqual(600);
    expect(PROMPT_VARIANTS.fewshot.length).toBeLessThanOrEqual(600);
  });

  it("示例为合成内容：特征短语与金标 fixture 正文零重叠（grep 证固化，防教模型背答案）", () => {
    const fixture = readFileSync(join(import.meta.dirname, "__fixtures__", "m1-dedup-golden.json"), "utf-8");
    expect(fixture.length).toBeGreaterThan(1000); // sanity：确实读到了金标正文
    for (const phrase of FEWSHOT_ANCHOR_PHRASES) {
      expect(fixture.includes(phrase), `金标 fixture 不应含示例短语「${phrase}」`).toBe(false);
    }
  });
});

// ── 注入点：fewshot 与 strict 同机制同防护 ──────────────────────────────

describe("withPromptVariant / variantWrappedRunner（fewshot）", () => {
  const baseParams: LLMRunParams = { prompt: "user", systemPrompt: "系统提示词", taskId: "l1-conflict-detection" };

  it("fewshot：systemPrompt = 原文 + 空行 + strict 收紧段 + 空行 + 判定示例小节", () => {
    const out = withPromptVariant(baseParams, "fewshot");
    expect(out.systemPrompt).toBe(`系统提示词\n\n${AB5_STRICT_PROMPT_SUFFIX}\n\n${AB5_FEWSHOT_EXAMPLES}`);
    expect(out.systemPrompt).toContain(AB5_STRICT_PROMPT_SUFFIX);
    expect(out.systemPrompt).toContain(AB5_FEWSHOT_EXAMPLES);
    expect(out.prompt).toBe("user");
    expect(out.taskId).toBe("l1-conflict-detection");
    // 不改写入参（纯函数）
    expect(baseParams.systemPrompt).toBe("系统提示词");
  });

  it("fewshot 但缺 systemPrompt：显式抛错（拒绝静默降级为 base）", () => {
    const p: LLMRunParams = { prompt: "user", taskId: "t" };
    expect(() => withPromptVariant(p, "fewshot")).toThrow(/systemPrompt/);
    expect(() => withPromptVariant(p, "fewshot")).toThrow(/fewshot/);
  });

  it("fewshot 包装：inner.run 收到的 systemPrompt 已追加组合段，返回值透传", async () => {
    const seen: LLMRunParams[] = [];
    const inner = {
      run: async (p: LLMRunParams) => {
        seen.push(p);
        return "decision";
      },
    };
    const out = await variantWrappedRunner(inner, "fewshot").run(baseParams);
    expect(out).toBe("decision");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.systemPrompt).toBe(`系统提示词\n\n${PROMPT_VARIANTS.fewshot}`);
  });
});
