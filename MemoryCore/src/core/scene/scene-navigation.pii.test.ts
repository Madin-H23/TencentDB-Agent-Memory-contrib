// Scene Navigation 段的 PII 脱敏（批次 1.1 / 审计 P0-1）。
//
// 背景：上游 persona-generator 只对 LLM 写的 body 脱敏，随后由工程代码追加的
// nav 段**不经过任何过滤**；nav 里的 Summary 逐字来自场景文件 META.summary，
// 于是私有邮箱/手机号被原样带进 persona.md，并经 /v2/core/read 与 rowfs 的
// 读时重渲染对外可见。
//
// 覆盖：正常路径、边界（空条目/空摘要）、路径不得被误脱敏、幂等。
import { describe, expect, it } from "vitest";
import { renderSceneNavigation, stripSceneNavigation } from "./scene-navigation.js";
import { PII_REDACTION } from "../../utils/pii-redact.js";
import type { SceneIndexEntry } from "./scene-index.js";

function entry(summary: string, filename = "场景A.md"): SceneIndexEntry {
  return { filename, summary, heat: 1, created: "2026-10-01", updated: "2026-10-20" };
}

const OPTS = {
  pathFor: (e: SceneIndexEntry) => `C:\\data\\scene_blocks\\${e.filename}`,
  readTool: "read",
  footer: "footer",
};

describe("renderSceneNavigation：PII 脱敏", () => {
  it("摘要里的私有邮箱不出现在 nav 段", () => {
    const nav = renderSceneNavigation([entry("收件统一 hewj23@163.com")], OPTS);
    expect(nav).not.toContain("hewj23");
    expect(nav).not.toContain("@163.com");
    expect(nav).toContain(PII_REDACTION);
  });

  it("手机号邮箱整体遮蔽，域名不残留", () => {
    const nav = renderSceneNavigation([entry("联系 13400526758@163.com")], OPTS);
    expect(nav).not.toContain("@163.com");
  });

  it("无 PII 的摘要原样出现在 nav 段", () => {
    const nav = renderSceneNavigation([entry("活库同文组回落至 1")], OPTS);
    expect(nav).toContain("活库同文组回落至 1");
  });

  it("路径行不被脱敏（本地 agent 靠它回读场景文件）", () => {
    const nav = renderSceneNavigation([entry("普通摘要")], OPTS);
    expect(nav).toContain("C:\\data\\scene_blocks\\场景A.md");
  });

  it("空条目列表 → 空串", () => {
    expect(renderSceneNavigation([], OPTS)).toBe("");
  });

  it("空摘要不产生异常", () => {
    const nav = renderSceneNavigation([entry("")], OPTS);
    expect(nav).toContain("Summary: ");
  });

  it("多条目时全部脱敏", () => {
    const nav = renderSceneNavigation(
      [entry("a@x.com", "A.md"), entry("b@y.org", "B.md")],
      OPTS,
    );
    expect(nav).not.toContain("x.com");
    expect(nav).not.toContain("y.org");
  });
});

describe("renderSceneNavigation：幂等", () => {
  it("对已脱敏的摘要重复渲染，结果稳定", () => {
    const once = renderSceneNavigation([entry("收件 hewj23@163.com")], OPTS);
    const twice = renderSceneNavigation([entry(once.includes(PII_REDACTION) ? PII_REDACTION : "收件 hewj23@163.com")], OPTS);
    expect(twice).toContain(PII_REDACTION);
    expect(twice).not.toContain("hewj23");
  });
});

describe("stripSceneNavigation：nav 段剥离", () => {
  it("nav 段可被完整剥离（回灌提示词前）", () => {
    const nav = renderSceneNavigation([entry("收件 hewj23@163.com")], OPTS);
    const persona = `正文内容\n\n${nav}`;
    const stripped = stripSceneNavigation(persona);
    expect(stripped).toBe("正文内容");
    expect(stripped).not.toContain("hewj23");
  });

  it("无 nav 段时原样返回", () => {
    expect(stripSceneNavigation("只有正文")).toBe("只有正文");
  });
});
