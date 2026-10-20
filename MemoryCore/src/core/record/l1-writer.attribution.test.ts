// 写库层归一护栏（批次 2.1 / 审计 P0-3）。
//
// 护栏原先只在抽取层作用于 mem.content，漏掉两条路径：
//   1. 去重后写库内容取 decision.merged_content（LLM 二次输出）—— 实测 6 行 version>0 越界
//   2. scene_name 原样赋值 —— 实测 198 行（9.83%）越界
// writeMemory 是两条写路径的唯一汇聚点，在这里统一处理。
//
// 覆盖：store / merge / update 三种 decision、content 与 scene_name 两个字段、
// 白名单保留、第三方丢弃、自指词归一、无白名单、异常输入。
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeMemory, type DedupDecision, type ExtractedMemory } from "./l1-writer.js";

const WHITELIST = ["何伟健", "heweijian", "Weijian He", "Madin-H23"];

function mem(content: string, sceneName = "归属场景"): ExtractedMemory {
  return {
    content,
    type: "episodic",
    priority: 50,
    source_message_ids: ["m1"],
    metadata: {},
    scene_name: sceneName,
  };
}

function decision(over: Partial<DedupDecision> = {}): DedupDecision {
  return {
    record_id: "m_test_1",
    action: "store",
    target_ids: [],
    ...over,
  };
}

async function write(
  content: string,
  sceneName: string,
  dec: DedupDecision,
  whitelist?: string[],
) {
  const baseDir = mkdtempSync(join(tmpdir(), "l1-writer-attr-"));
  try {
    return await writeMemory({
      memory: mem(content, sceneName),
      decision: dec,
      baseDir,
      sessionKey: "zcode-default",
      sessionId: "sess-attr",
      userIdentityNames: whitelist,
    });
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
}

describe("writeMemory：content 归一", () => {
  it("store 路径：第三方姓名归一为「用户」", async () => {
    const r = await write("用户（王缘林）提交了代码", "场景", decision(), WHITELIST);
    expect(r!.content).toBe("用户提交了代码");
  });

  it("store 路径：白名单姓名原样保留", async () => {
    const r = await write("用户（何伟健）批准上线", "场景", decision(), WHITELIST);
    expect(r!.content).toBe("用户（何伟健）批准上线");
  });

  it("merge 路径：merged_content 同样被归一（此前完全绕过护栏）", async () => {
    const r = await write(
      "用户（何伟健）原始内容",
      "场景",
      decision({ action: "merge", target_ids: ["old_1"], merged_content: "用户（王缘林）合并后的内容" }),
      WHITELIST,
    );
    expect(r!.content).toBe("用户合并后的内容");
  });

  it("update 路径：merged_content 同样被归一", async () => {
    const r = await write(
      "原始",
      "场景",
      decision({ action: "update", target_ids: ["old_1"], merged_content: "用户（28951）更新后的内容" }),
      WHITELIST,
    );
    expect(r!.content).toBe("用户更新后的内容");
  });

  it("复合标签：用户本人的多写法被保留", async () => {
    const r = await write("用户（何伟健/heweijian）联合确认", "场景", decision(), WHITELIST);
    expect(r!.content).toBe("用户（何伟健/heweijian）联合确认");
  });

  it("复合标签：含第三方姓名时整串丢弃", async () => {
    const r = await write("用户（何伟健/王缘林）联合确认", "场景", decision(), WHITELIST);
    expect(r!.content).toBe("用户联合确认");
  });

  it("自指词归一为「用户」", async () => {
    const r = await write("用户（本人）确认", "场景", decision(), WHITELIST);
    expect(r!.content).toBe("用户确认");
  });

  it("无白名单 → 全部非自指标签归一", async () => {
    const r = await write("用户（张三）来了", "场景", decision(), undefined);
    expect(r!.content).toBe("用户来了");
  });
});

describe("writeMemory：scene_name 归一", () => {
  it("路径数字标签被丢弃（实测现场 162 行「用户（28951）」）", async () => {
    const r = await write("内容", "我（AI）在和用户（28951）盘点文档模块缺口", decision(), WHITELIST);
    expect(r!.scene_name).toBe("我（AI）在和用户盘点文档模块缺口");
  });

  it("角色标签被丢弃（实测现场 29 行「用户（副用 Coding Agent）」）", async () => {
    const r = await write("内容", "用户（副用 Coding Agent）正在推进", decision(), WHITELIST);
    expect(r!.scene_name).toBe("用户正在推进");
  });

  it("白名单姓名在 scene_name 中保留", async () => {
    const r = await write("内容", "我（AI）和用户（何伟健）在讨论", decision(), WHITELIST);
    expect(r!.scene_name).toBe("我（AI）和用户（何伟健）在讨论");
  });

  it("不含「用户（X）」句式的 scene_name 原样保留", async () => {
    const r = await write("内容", "我（AI）和Weijian He执行PR战役", decision(), WHITELIST);
    expect(r!.scene_name).toBe("我（AI）和Weijian He执行PR战役");
  });

  it("空 scene_name 不抛异常", async () => {
    const r = await write("内容", "", decision(), WHITELIST);
    expect(r!.scene_name).toBe("");
  });
});

describe("writeMemory：skip 与异常", () => {
  it("action=skip → 返回 null，不写库", async () => {
    const r = await write("用户（王缘林）内容", "场景", decision({ action: "skip" }), WHITELIST);
    expect(r).toBeNull();
  });

  it("空 content 不抛异常", async () => {
    const r = await write("", "场景", decision(), WHITELIST);
    expect(r!.content).toBe("");
  });
});
