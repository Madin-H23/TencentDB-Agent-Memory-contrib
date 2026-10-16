// B1（2026-10-16，继续中断的 A/B/C）：字符串感知的未转义引号修复。
// 实证样本（10-15 PARSE_FAIL，日志 rawFull 定位）：LLM 把英文双引号裸写进
// content 值——`...github.com git端点断开则用SSH over 443，"Everything up-to-date"
// 需ls-remote核实...`——JSON.parse 在第一个裸引号后即崩（Expecting ',' delimiter），
// 整轮抽取作废走 parse_fail 延后。修法：repairExtractionJson 增加逐字符扫描，
// 字符串内的 `"` 若后续非结构字符（, } ] :）/ EOF 则转义为 \"（内容原样保留）。
// 安全底线：合法 JSON 必须原样通过（合法串内不存在裸引号）——幂等性有专测。
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractL1Memories } from "./l1-extractor.js";
import type { LLMRunner } from "../types.js";

const T = 1_700_000_000_000;

function runWithRaw(raw: string) {
  const llm = { run: async () => raw } as unknown as LLMRunner;
  const baseDir = mkdtempSync(join(tmpdir(), "b1-quote-"));
  return extractL1Memories({
    messages: [{ id: "m1", role: "user" as const, content: "触发", timestamp: T }],
    sessionKey: "zcode-default",
    sessionId: "sess-b1",
    baseDir,
    config: {},
    options: { enableDedup: false, promptMode: "chat", llmRunner: llm },
  }).finally(() => rmSync(baseDir, { recursive: true, force: true }));
}

describe("B1：字符串内未转义英文引号修复（10-15 实证样本形态）", () => {
  it("真实样本形状：content 裸引号（\"Everything up-to-date\"）不再整轮作废", async () => {
    // 还原日志定位到的坏形（ trimmed）：SSH over 443 后的英文引号未转义
    const raw = JSON.stringify([
      {
        scene_name: "PR战役S2巡检规则",
        message_ids: ["m1"],
        memories: [
          {
            content:
              '用户要求S2巡检遵守规则；Karing(3067)掉线时通过取消代理环境变量直连，github.com git端点断开则用SSH over 443，"Everything up-to-date"需ls-remote核实；STATE.md仅追加[S2]段落。',
            type: "instruction",
            priority: 80,
            source_message_ids: ["m1"],
            metadata: {},
          },
        ],
      },
    ]).replace('443,\\"Everything', '443,"Everything').replace('up-to-date\\"需', 'up-to-date"需');
    const r = await runWithRaw(raw);
    expect(r.storedCount).toBe(1);
    // 引号作为内容原样保留（不是被删掉或替换）
    expect(r.records[0]!.content).toContain('"Everything up-to-date"');
    expect(r.records[0]!.content).toContain("SSH over 443");
  });

  it("合法 JSON 原样通过（幂等——修复不得改动本来就能parse的输入）", async () => {
    const raw = JSON.stringify([
      {
        scene_name: "s",
        message_ids: ["m1"],
        memories: [
          { content: '合法内容：中文引号「」和""不需修复，原样入库', type: "episodic", priority: 50, source_message_ids: ["m1"], metadata: {} },
        ],
      },
    ]);
    const r = await runWithRaw(raw);
    expect(r.storedCount).toBe(1);
    expect(r.records[0]!.content).toBe('合法内容：中文引号「」和""不需修复，原样入库');
  });

  it("已正确转义的英文引号 round-trip 不变（\\\" 形态不被二次转义）", async () => {
    // JS 字符串里的真引号经 JSON.stringify 成为 \"——合法输入，须原样解析回带引号内容
    const raw = JSON.stringify([
      {
        scene_name: "s",
        message_ids: ["m1"],
        memories: [
          { content: '他说"你好"然后"再见"', type: "episodic", priority: 50, source_message_ids: ["m1"], metadata: {} },
        ],
      },
    ]);
    expect(raw).toContain('\\"'); // 前置确认：stringify 确实产出了转义形态
    const r = await runWithRaw(raw);
    expect(r.storedCount).toBe(1);
    expect(r.records[0]!.content).toBe('他说"你好"然后"再见"');
  });

  it("一条值内多个裸引号 + scene_name 内裸引号同时修", async () => {
    const raw = [
      "{",
      '  "scene_name": "他说"你好"场景",',
      '  "message_ids": ["m1"],',
      '  "memories": [',
      "    {",
      '      "content": "规则：先跑"测试"再"合并"，失败则"回退"。",',
      '      "type": "instruction",',
      '      "priority": 70,',
      '      "source_message_ids": ["m1"],',
      '      "metadata": {}',
      "    }",
      "  ]",
      "}",
    ].join("\n");
    const r = await runWithRaw(`[${raw}]`);
    expect(r.storedCount).toBe(1);
    expect(r.records[0]!.content).toBe("规则：先跑\"测试\"再\"合并\"，失败则\"回退\"。");
  });

  it("与既有修复叠加：裸引号 + 裸 priority + 尾逗号同一输入", async () => {
    const raw = [
      "{",
      '  "scene_name": "s",',
      '  "message_ids": ["m1"],',
      '  "memories": [',
      "    {",
      '      "content": "他说"你好"",',
      '      "type": "episodic",',
      '      "priority": 高,',
      '      "source_message_ids": ["m1"],',
      '      "metadata": {},',
      "    },",
      "  ]",
      "}",
    ].join("\n");
    const r = await runWithRaw(`[${raw}]`);
    expect(r.storedCount).toBe(1);
    expect(r.records[0]!.content).toBe('他说"你好"');
    expect(r.records[0]!.priority).toBe(50); // 裸 priority 仍被兜底为 50
  });

  it("修不好的真损坏（截断 JSON）仍走 parse_error 抛错延后（不谎报成功）", async () => {
    // S1 fail-closed 语义：修复不了的结构垃圾抛 L1ExtractionFailure（批次延后、
    // 游标不动），不是静默 returning 0——这里钉 throw 形态
    await expect(runWithRaw('[{"scene_name": "s", "memories": [{"content": "半截')).rejects.toThrow(
      /structural garbage/,
    );
  });
});
