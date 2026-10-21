// P2（2026-10-14，v2 3eb7c8b 移植）：extractor 集成——入库前对每条记忆执行
// 白名单归一；白名单经 options.userIdentityNames 传入（cfg.extraction.userIdentityNames）。
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractL1Memories } from "./l1-extractor.js";
import type { LLMRunner } from "../types.js";

const T = 1_700_000_000_000;

function run(content: string, whitelist?: string[]) {
  const llm = {
    run: async () =>
      JSON.stringify([
        { scene_name: "归属场景", message_ids: ["m1"], memories: [{ type: "episodic", content, priority: 50 }] },
      ]),
  } as unknown as LLMRunner;
  const baseDir = mkdtempSync(join(tmpdir(), "extractor-attr-"));
  return extractL1Memories({
    messages: [{ id: "m1", role: "user" as const, content: "触发消息", timestamp: T }],
    sessionKey: "zcode-default",
    sessionId: "sess-attr",
    baseDir,
    config: {},
    options: { enableDedup: false, promptMode: "chat", llmRunner: llm, userIdentityNames: whitelist },
  }).finally(() => rmSync(baseDir, { recursive: true, force: true }));
}

describe("extractL1Memories：入库前白名单归一", () => {
  it("白名单内姓名保留、第三方姓名归一", async () => {
    const r = await run("用户（何伟健）批准上线；用户（王缘林）提出异议", ["何伟健"]);
    expect(r.storedCount).toBe(1);
    expect(r.records[0]!.content).toBe("用户（何伟健）批准上线；用户提出异议");
  });

  it("未配白名单 → 全部非自指标签归一", async () => {
    const r = await run("用户（导师）要求修改；用户（本人）同意", undefined);
    expect(r.records[0]!.content).toBe("用户要求修改；用户同意");
  });
});

// 2026-10-21（面板需求「增加是哪个会话的记录出错」）：失败消息尾部带
// (model=…, provider=…, session=…)——面板 PM_SUFFIX_RE 按此解析厂商:模型与**会话**。
// session= 就是出错那条会话（抽取器逐 sid 分组跑，sessionId 即该组 sid）。
describe("extractL1Memories：失败消息带归属与会话", () => {
  it("上游失败 → 错误消息含 (model, provider, session) 后缀", async () => {
    const llm = {
      run: async () => {
        throw new Error("upstream boom");
      },
    } as unknown as LLMRunner;
    const baseDir = mkdtempSync(join(tmpdir(), "extractor-session-"));
    try {
      await expect(
        extractL1Memories({
          messages: [{ id: "m1", role: "user" as const, content: "触发消息", timestamp: T }],
          sessionKey: "zcode-default",
          sessionId: "sess-attr",
          baseDir,
          config: {},
          options: {
            enableDedup: false,
            promptMode: "chat",
            llmRunner: llm,
            model: "minimax-m3.1-flash-free",
            providerLabel: "opencode-go",
          },
        }),
      ).rejects.toThrow(/\(model=minimax-m3\.1-flash-free, provider=opencode-go, session=sess-attr\)/);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });
});
