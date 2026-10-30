// 方案B：scene-extraction 提示词追加「大文件分段读」规则。
// 红线：只追加，不删既有规则（两个 prompt family 同构追加）。
import { describe, expect, it } from "vitest";
import { buildSceneExtractionPrompt } from "./scene-extraction.js";

const BASE_PARAMS = {
  memoriesJson: "[{}]",
  sceneSummaries: "- work.md: demo",
  currentTimestamp: "2026-10-29T00:00:00Z",
  maxScenes: 8,
};

/** 既有规则的锚点（改动前已存在，追加后必须仍在）。 */
const EXISTING_RULE_ANCHORS = [
  "read 只能读取用户消息中",
  "删除文件的唯一方式",
  "禁止创建报告/整合/汇总类文件",
  "[DELETED]",
];

describe("scene-extraction 提示词：大文件分段读规则（只追加不删）", () => {
  it("chat 模式：追加分段读规则（offset/limit 预览 + oldText 必须来自已读片段）", () => {
    const { systemPrompt } = buildSceneExtractionPrompt({ ...BASE_PARAMS, promptMode: "chat" });
    expect(systemPrompt).toContain("分段预览");
    expect(systemPrompt).toContain("offset");
    expect(systemPrompt).toContain("limit");
    expect(systemPrompt).toContain("必须逐字来自已读片段");
    expect(systemPrompt).toContain("8. **大文件分段读**");
  });

  it("work 模式：同构追加分段读规则", () => {
    const { systemPrompt } = buildSceneExtractionPrompt({ ...BASE_PARAMS, promptMode: "code" });
    expect(systemPrompt).toContain("分段预览");
    expect(systemPrompt).toContain("offset");
    expect(systemPrompt).toContain("limit");
    expect(systemPrompt).toContain("必须逐字来自已读片段");
    expect(systemPrompt).toContain("8. **大文件分段读**");
  });

  it("新规则每个 family 只出现一次（追加一条，不散落多处）", () => {
    for (const promptMode of ["chat", "code"] as const) {
      const { systemPrompt } = buildSceneExtractionPrompt({ ...BASE_PARAMS, promptMode });
      const count = systemPrompt.split("8. **大文件分段读**").length - 1;
      expect(count).toBe(1);
    }
  });

  it("既有规则全部保留（chat + work 两模式）", () => {
    for (const promptMode of ["chat", "code"] as const) {
      const { systemPrompt } = buildSceneExtractionPrompt({ ...BASE_PARAMS, promptMode });
      for (const anchor of EXISTING_RULE_ANCHORS) {
        expect(systemPrompt, `promptMode=${promptMode} 缺少既有规则锚点: ${anchor}`).toContain(anchor);
      }
    }
  });

  it("追加位置在既有第 7 条之后（顺序 7 → 8）", () => {
    for (const promptMode of ["chat", "code"] as const) {
      const { systemPrompt } = buildSceneExtractionPrompt({ ...BASE_PARAMS, promptMode });
      const idx7 = systemPrompt.indexOf("7. **禁止创建报告/整合/汇总类文件**");
      const idx8 = systemPrompt.indexOf("8. **大文件分段读**");
      expect(idx7).toBeGreaterThan(-1);
      expect(idx8).toBeGreaterThan(idx7);
    }
  });
});

// ---------------------------------------------------------------------------
// P0-C（2026-10-30 交叉评审修复）：write 护栏 —— 禁止凭分段读的残缺视图用
// write 整体重写已存在文件；更新一律 edit。
// ---------------------------------------------------------------------------

describe("scene-extraction 提示词：write 护栏（2026-10-30 交叉评审 P0-C）", () => {
  for (const promptMode of ["chat", "code"] as const) {
    it(`${promptMode}：第 8 条追加 write 护栏（未完整读过禁止整体重写）`, () => {
      const { systemPrompt } = buildSceneExtractionPrompt({ ...BASE_PARAMS, promptMode });
      expect(systemPrompt).toContain("已存在且未完整读过的文件**禁止**用 write 整体重写");
      expect(systemPrompt).toContain("write 仅限新建文件与 `[DELETED]` 标记");
      expect(systemPrompt).toContain("更新一律 edit，newText 只含新增/替换部分");
      expect(systemPrompt).toContain("宁可只对已读片段做 edit 追加并如实说明");
      expect(systemPrompt).toContain("不得凭残缺视图重构未读部分");
    });

    it(`${promptMode}：第 4 条改条件式（仅本次完整读过/新建才允许 read+write 整体重写）`, () => {
      const { systemPrompt } = buildSceneExtractionPrompt({ ...BASE_PARAMS, promptMode });
      expect(systemPrompt).toContain(
        "大范围重写仅当**本次已完整读过该文件**（或文件是新建）才允许 read + write 整体重写",
      );
      // 旧的无条件建议必须移除（改条件式 ≠ 追加）
      expect(systemPrompt).not.toContain("建议使用 **read** + **write** 整体重写");
    });

    it(`${promptMode}：护栏文本每个 family 只出现一次（不散落多处）`, () => {
      const { systemPrompt } = buildSceneExtractionPrompt({ ...BASE_PARAMS, promptMode });
      const count = systemPrompt.split("已存在且未完整读过的文件").length - 1;
      expect(count).toBe(1);
    });

    it(`${promptMode}：护栏出现在第 8 条内（oldText 规则之后）`, () => {
      const { systemPrompt } = buildSceneExtractionPrompt({ ...BASE_PARAMS, promptMode });
      const idx8 = systemPrompt.indexOf("8. **大文件分段读**");
      const idxGuard = systemPrompt.indexOf("已存在且未完整读过的文件");
      expect(idx8).toBeGreaterThan(-1);
      expect(idxGuard).toBeGreaterThan(idx8);
    });
  }
});

// ---------------------------------------------------------------------------
// P1-2（2026-10-30 交叉评审修复）：分段读示例 limit 提到 12000~16000 区间，
// 并补步数预算与读尾指引。
// ---------------------------------------------------------------------------

describe("scene-extraction 提示词：分段读 limit 示例与步数预算指引（P1-2）", () => {
  for (const promptMode of ["chat", "code"] as const) {
    it(`${promptMode}：示例 limit 在 12000~16000 区间（1500 旧值移除）`, () => {
      const { systemPrompt } = buildSceneExtractionPrompt({ ...BASE_PARAMS, promptMode });
      expect(systemPrompt).toContain("limit:15000");
      expect(systemPrompt).not.toContain("limit:1500}");
      expect(systemPrompt).toContain("12000~16000");
    });

    it(`${promptMode}：步数预算与读尾指引齐全`, () => {
      const { systemPrompt } = buildSceneExtractionPrompt({ ...BASE_PARAMS, promptMode });
      expect(systemPrompt).toContain("按文件规模选 limit");
      expect(systemPrompt).toContain("总长/limit≈步数预算");
      expect(systemPrompt).toContain("≤15 步");
      expect(systemPrompt).toContain("优先读文件尾最新批次");
    });

    it(`${promptMode}：旧 oldText 逐字规则与分段预览措辞保留（锚点不回退）`, () => {
      const { systemPrompt } = buildSceneExtractionPrompt({ ...BASE_PARAMS, promptMode });
      expect(systemPrompt).toContain("分段预览");
      expect(systemPrompt).toContain("必须逐字来自已读片段");
    });
  }
});
