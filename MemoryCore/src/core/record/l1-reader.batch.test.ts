// L1 记录读取的**批次上限**（2026-10-22，配套 persona.maxL2Batch）：
//   L2 场景抽取此前把"游标之后的全部记录"塞进一次提示词 ⇒ 积压时单轮 40 万字符
//   ⇒ 必然撞上下文 + 内存尖峰（§13.14/§13.15）。现在读取侧可限量：
//   **按 updatedAt 升序取前 N 条**，并对"与最后一条同 updatedAt"的兄弟记录**扩边**
//   （实测 L1 记录里同毫秒同值最多一组 39 条；游标是严格大于语义，
//    不扩边就会把同值兄弟跳过 ⇒ 丢数据）。
import { describe, it, expect } from "vitest";
import { queryMemoryRecords } from "./l1-reader.js";
import type { L1RecordRow } from "../store/types.js";

function makeRow(id: string, updated: string): L1RecordRow {
  return {
    record_id: id,
    content: `内容 ${id}`,
    type: "episodic",
    priority: 50,
    scene_name: "场景",
    session_key: "zcode-default",
    session_id: "sess-1",
    team_id: "default",
    task_id: "t1",
    user_id: "default",
    agent_id: "default",
    version: 1,
    timestamp_str: updated,
    timestamp_start: updated,
    timestamp_end: updated,
    created_time: updated,
    updated_time: updated,
    metadata_json: "{}",
  };
}

function makeStore(rows: L1RecordRow[]) {
  return {
    isDegraded: () => false,
    queryL1Records: async () => rows,
  } as never;
}

const ts = (n: number) => new Date(Date.UTC(2026, 9, 22, 0, 0, 0) + n * 1000).toISOString();

describe("queryMemoryRecords 批次上限（limit）", () => {
  it("limit 生效：按 updatedAt 升序取前 N 条", async () => {
    const rows = [makeRow("c", ts(3)), makeRow("a", ts(1)), makeRow("b", ts(2))];
    const out = await queryMemoryRecords(makeStore(rows), undefined, undefined, { limit: 2 });
    expect(out.map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("同值兄弟扩边：与最后一条同 updatedAt 的记录一并纳入（游标严格大于 ⇒ 不扩边会丢）", async () => {
    // 4 条同值 + 1 条更新：limit=2 时应把 4 条同值全纳入（"later" 时间戳不同，属下一批）
    const rows = [
      makeRow("s1", ts(1)),
      makeRow("s2", ts(1)),
      makeRow("s3", ts(1)),
      makeRow("s4", ts(1)),
      makeRow("later", ts(2)),
    ];
    const out = await queryMemoryRecords(makeStore(rows), undefined, undefined, { limit: 2 });
    const ids = out.map((r) => r.id).sort();
    expect(ids).toEqual(["s1", "s2", "s3", "s4"]);
    expect(ids).not.toContain("later"); // 不同时间戳 ⇒ 下一批
  });

  it("未设 limit：行为不变（全部返回，保持存储原序）", async () => {
    const rows = [makeRow("c", ts(3)), makeRow("a", ts(1)), makeRow("b", ts(2))];
    const out = await queryMemoryRecords(makeStore(rows));
    expect(out.map((r) => r.id)).toEqual(["c", "a", "b"]);
  });

  it("limit 大于记录数：全部返回", async () => {
    const rows = [makeRow("a", ts(1)), makeRow("b", ts(2))];
    const out = await queryMemoryRecords(makeStore(rows), undefined, undefined, { limit: 50 });
    expect(out.map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("无 VectorStore：返回空数组（既有契约不变）", async () => {
    const out = await queryMemoryRecords(null, undefined, undefined, { limit: 5 });
    expect(out).toEqual([]);
  });
});
