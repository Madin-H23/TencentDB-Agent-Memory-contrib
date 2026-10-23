/**
 * 票 01（2026-10-24 金标 5 候选复测）单测：数据集 schema 校验 + 注入策略纯函数。
 *
 * 覆盖：三态（db 池内 / db 超召回 / injected 注入）、种子确定性、边界（孪生恰在
 * 第 50/51 名）、newer 自身剔除、落位 clamp、加载校验异常路径（schema 非法 /
 * pid 不齐 / 空池 / 超长池 / twin 标记不一致 / 池内 id 重复）。
 * 样本 fixture 全部用合成内容，不含真实库正文（校验逻辑与数据分离，票面约束）。
 */
import { describe, it, expect } from "vitest";

import {
  GOLDEN_5CAND_SCHEMA,
  build5CandPair,
  loadGolden5CandDataset,
  placementRank,
  placementRangeForBucket,
  validateGolden5CandPair,
} from "./golden-5cand.js";
import { loadGoldenFixture, type GoldenFixture, type GoldenPair } from "./golden-fixture.js";
import type { L1SearchResult } from "../store/types.js";

// ── 合成样本构造（零真实 PII）──────────────────────────────────────────

/** 池行：与 searchL1Fts 返回同形状（L1SearchResult 字段面）。 */
function makeRow(recordId: string, score = 0.5): L1SearchResult {
  return {
    record_id: recordId,
    content: `池行内容-${recordId}`,
    type: "preference",
    priority: 80,
    scene_name: "测试场景",
    score,
    timestamp_str: "2026-10-24T00:00:00.000Z",
    timestamp_start: "2026-10-24T00:00:00.000Z",
    timestamp_end: "2026-10-24T00:00:00.000Z",
    version: 0,
    session_key: "zcode-default",
    session_id: "sess-test",
    team_id: "default",
    task_id: "",
    user_id: "default",
    agent_id: "default",
    metadata_json: "{}",
  };
}

/** 金标对：合成内容；older_id/newer_id 按 fixture 惯例由调用方派生。 */
function makeGoldenPair(pid: string, over: Partial<GoldenPair> = {}): GoldenPair {
  return {
    pid,
    band: "exact",
    subset: "high-sim",
    sim: 0.95,
    rank_older: 3,
    rank_bucket: "top-5",
    type_older: "preference",
    type_newer: "preference",
    content_older: `测试金标旧记忆-${pid}：用户偏好把临时产物集中放在固定目录`,
    content_newer: `测试金标新记忆-${pid}：用户再次确认临时产物统一放固定目录`,
    answer_user: "merge",
    ...over,
  };
}

const ids = (pid: string) => ({ olderId: `old-${pid}`, newerId: `new-${pid}` });

function buildPair(pid: string, rows: L1SearchResult[], twinInDb: boolean, bucket: GoldenPair["rank_bucket"] = "top-5") {
  const { olderId, newerId } = ids(pid);
  return build5CandPair({
    golden: makeGoldenPair(pid, { rank_bucket: bucket }),
    olderId,
    newerId,
    searchRows: rows,
    twinInDb,
    seed: "test-seed",
  });
}

function makeGoldenFixture(pids: string[]): GoldenFixture {
  return loadGoldenFixture({
    schema: "m1-dedup-golden/v1",
    created_at: "2026-10-24T00:00:00.000Z",
    source: { test: true },
    pairs: pids.map((pid) => makeGoldenPair(pid)),
  });
}

// ── 注入策略纯函数 ──────────────────────────────────────────────────────

describe("build5CandPair 三态", () => {
  it("态① 孪生在池内：twin_source=db、twin_rank=池内位置、pool 原序", () => {
    const { olderId, newerId } = ids("p1");
    const rows = [makeRow("r1"), makeRow(olderId, 0.9), makeRow("r3"), makeRow(newerId)];
    const pair = buildPair("p1", rows, true);
    expect(pair.pid).toBe("p1");
    expect(pair.twin_id).toBe(olderId);
    expect(pair.twin_source).toBe("db");
    expect(pair.twin_beyond_recall).toBe(false);
    expect(pair.twin_rank).toBe(2); // newer 剔除后孪生位于第 2 位
    expect(pair.pool.map((r) => r.record_id)).toEqual(["r1", olderId, "r3"]);
    expect(pair.pool.some((r) => r.record_id === newerId)).toBe(false);
  });

  it("态② 孪生在库但不在 top-50：beyond_recall=true、twin_rank=null、pool 不含孪生", () => {
    const { olderId } = ids("p2");
    const rows = Array.from({ length: 50 }, (_, i) => makeRow(`r${i}`));
    const pair = buildPair("p2", rows, true);
    expect(pair.twin_source).toBe("db");
    expect(pair.twin_beyond_recall).toBe(true);
    expect(pair.twin_rank).toBeNull();
    expect(pair.pool).toHaveLength(50);
    expect(pair.pool.some((r) => r.record_id === olderId)).toBe(false);
  });

  it("态③ 孪生已删：injected、合成行按种子落位插入并挤掉池尾", () => {
    const { olderId } = ids("p3");
    const rows = Array.from({ length: 50 }, (_, i) => makeRow(`r${i}`));
    const pair = buildPair("p3", rows, false, "6-10");
    expect(pair.twin_source).toBe("injected");
    expect(pair.twin_beyond_recall).toBe(false);
    const rank = pair.twin_rank!;
    expect(rank).toBeGreaterThanOrEqual(6);
    expect(rank).toBeLessThanOrEqual(10);
    expect(pair.pool).toHaveLength(50); // 插入后挤掉池尾
    expect(pair.pool[rank - 1]!.record_id).toBe(olderId);
    expect(pair.pool.some((r) => r.record_id === "r49")).toBe(false); // 池尾行被挤掉
  });
});

describe("注入合成行与确定性", () => {
  it("合成行字段：older 内容+type、scene_name 空串、priority 80、record_id=older_id", () => {
    const { olderId } = ids("p4");
    const pair = buildPair("p4", [makeRow("r1")], false, "top-5");
    expect(pair.twin_source).toBe("injected");
    const twin = pair.pool.find((r) => r.record_id === olderId)!;
    expect(twin).toBeDefined();
    expect(twin.content).toBe(`测试金标旧记忆-p4：用户偏好把临时产物集中放在固定目录`);
    expect(twin.type).toBe("preference");
    expect(twin.scene_name).toBe("");
    expect(twin.priority).toBe(80);
    expect(twin.score).toBe(0);
  });

  it("种子确定性：同 seed 同 pid 两次构建完全一致", () => {
    const { olderId } = ids("p5");
    const rows = Array.from({ length: 50 }, (_, i) => makeRow(`r${i}`));
    const mk = () =>
      build5CandPair({
        golden: makeGoldenPair("p5", { rank_bucket: "6-10" }),
        olderId,
        newerId: ids("p5").newerId,
        searchRows: rows,
        twinInDb: false,
        seed: "fixed-seed",
      });
    const a = mk();
    const b = mk();
    expect(a.twin_rank).toBe(b.twin_rank);
    expect(a.pool).toEqual(b.pool);
    expect(placementRank("6-10", "p5", "fixed-seed")).toBe(placementRank("6-10", "p5", "fixed-seed"));
  });

  it("placementRank 落在预注册区间内（多 pid 批量断言）", () => {
    for (let i = 0; i < 40; i++) {
      const pid = `bulk-${i}`;
      const t5 = placementRank("top-5", pid, "s");
      expect(t5).toBeGreaterThanOrEqual(1);
      expect(t5).toBeLessThanOrEqual(5);
      const m = placementRank("11-50", pid, "s");
      expect(m).toBeGreaterThanOrEqual(11);
      expect(m).toBeLessThanOrEqual(50);
    }
  });

  it("placementRangeForBucket 映射：absent/no_query→6-10；50+ 未注册→显式抛错", () => {
    expect(placementRangeForBucket("top-5")).toEqual([1, 5]);
    expect(placementRangeForBucket("6-10")).toEqual([6, 10]);
    expect(placementRangeForBucket("11-50")).toEqual([11, 50]);
    expect(placementRangeForBucket("absent")).toEqual([6, 10]);
    expect(placementRangeForBucket("no_query")).toEqual([6, 10]);
    expect(() => placementRangeForBucket("50+")).toThrow(/50\+/);
  });
});

describe("边界与剔除", () => {
  it("newer 自身在命中里被剔除，孪生名次相应前移", () => {
    const { olderId, newerId } = ids("p6");
    const rows = [makeRow(newerId), makeRow("r2"), makeRow(olderId)];
    const pair = buildPair("p6", rows, true);
    expect(pair.pool.map((r) => r.record_id)).toEqual(["r2", olderId]);
    expect(pair.twin_rank).toBe(2);
  });

  it("边界：孪生恰在第 50 名 → 池内名次 50", () => {
    const { olderId } = ids("p7");
    const rows = [...Array.from({ length: 49 }, (_, i) => makeRow(`r${i}`)), makeRow(olderId)];
    const pair = buildPair("p7", rows, true);
    expect(pair.twin_source).toBe("db");
    expect(pair.twin_beyond_recall).toBe(false);
    expect(pair.twin_rank).toBe(50);
    expect(pair.pool).toHaveLength(50);
  });

  it("边界：孪生在第 51 名（top-50 契约截断）→ beyond_recall=true", () => {
    const { olderId } = ids("p8");
    const rows = [...Array.from({ length: 50 }, (_, i) => makeRow(`r${i}`)), makeRow(olderId)];
    const pair = buildPair("p8", rows, true);
    expect(pair.twin_source).toBe("db");
    expect(pair.twin_beyond_recall).toBe(true);
    expect(pair.twin_rank).toBeNull();
    expect(pair.pool).toHaveLength(50);
    expect(pair.pool.some((r) => r.record_id === olderId)).toBe(false);
  });

  it("落位 clamp：bucket=11-50 但池只有 3 行 → 落位池尾后一位（4）", () => {
    const { olderId } = ids("p9");
    const pair = buildPair("p9", [makeRow("r1"), makeRow("r2"), makeRow("r3")], false, "11-50");
    expect(pair.twin_source).toBe("injected");
    expect(pair.twin_rank).toBe(4);
    expect(pair.pool).toHaveLength(4);
    expect(pair.pool[3]!.record_id).toBe(olderId);
  });

  it("零命中且孪生仍在库：退化为注入态（空池在数据集 schema 中非法）", () => {
    const { olderId } = ids("p10");
    const pair = buildPair("p10", [], true, "absent");
    expect(pair.twin_source).toBe("injected");
    expect(pair.twin_rank).not.toBeNull();
    expect(pair.pool).toHaveLength(1);
    expect(pair.pool[0]!.record_id).toBe(olderId);
  });
});

// ── 加载校验 ────────────────────────────────────────────────────────────

describe("loadGolden5CandDataset", () => {
  /** 用 build5CandPair 产出合法数据集对（再 JSON 往返模拟落盘加载）。 */
  function makeValidRaw(pids: string[]) {
    const fx = makeGoldenFixture(pids);
    const pairs = pids.map((pid) => {
      const rows = [makeRow("r1"), makeRow(`r-${pid}`)];
      const p = buildPair(pid, rows, false, "6-10");
      return p;
    });
    return {
      fx,
      raw: JSON.parse(JSON.stringify({ schema: GOLDEN_5CAND_SCHEMA, created_at: "2026-10-24T00:00:00.000Z", source: {}, pairs })),
    };
  }

  it("正常路径：合法数据集 + pid 对齐金标 → 加载成功", () => {
    const { fx, raw } = makeValidRaw(["a", "b"]);
    const ds = loadGolden5CandDataset(raw, fx);
    expect(ds.schema).toBe(GOLDEN_5CAND_SCHEMA);
    expect(ds.pairs).toHaveLength(2);
    expect(ds.pairs.map((p) => p.pid)).toEqual(["a", "b"]);
  });

  it("schema 非法 → 抛错", () => {
    const { fx, raw } = makeValidRaw(["a"]);
    expect(() => loadGolden5CandDataset({ ...raw, schema: "m1-5cand/v9" }, fx)).toThrow(/schema/);
  });

  it("pid 与金标不齐：缺对 / 多对 → 抛错", () => {
    const { fx, raw } = makeValidRaw(["a", "b"]);
    expect(() => loadGolden5CandDataset({ ...raw, pairs: raw.pairs.slice(0, 1) }, fx)).toThrow(/缺少/);
    expect(() => loadGolden5CandDataset({ ...raw, pairs: [...raw.pairs, ...raw.pairs.slice(0, 1).map((p: { pid: string }) => ({ ...p, pid: "extra" }))] }, fx)).toThrow(/多余/);
  });

  it("pool 超长（51 行）→ 抛错", () => {
    const { fx, raw } = makeValidRaw(["a"]);
    const bad = JSON.parse(JSON.stringify(raw));
    bad.pairs[0].pool = Array.from({ length: 51 }, (_, i) => makeRow(`x${i}`));
    bad.pairs[0].twin_source = "db";
    bad.pairs[0].twin_beyond_recall = true;
    bad.pairs[0].twin_rank = null;
    expect(() => loadGolden5CandDataset(bad, fx)).toThrow(/50/);
  });

  it("空池 → 抛错", () => {
    const { fx, raw } = makeValidRaw(["a"]);
    const bad = JSON.parse(JSON.stringify(raw));
    bad.pairs[0].pool = [];
    bad.pairs[0].twin_source = "db";
    bad.pairs[0].twin_beyond_recall = true;
    bad.pairs[0].twin_rank = null;
    expect(() => loadGolden5CandDataset(bad, fx)).toThrow(/非空/);
  });

  it("twin 标记不一致（三种）→ 抛错", () => {
    const { fx, raw } = makeValidRaw(["a"]);
    const mk = (mut: (p: Record<string, unknown>) => void) => {
      const bad = JSON.parse(JSON.stringify(raw));
      mut(bad.pairs[0]);
      return bad;
    };
    // beyond=true 但 twin_rank 非 null
    expect(() =>
      loadGolden5CandDataset(mk((p) => { p.twin_beyond_recall = true; p.twin_rank = 1; }), fx),
    ).toThrow();
    // injected 但 beyond=true
    expect(() =>
      loadGolden5CandDataset(mk((p) => { p.twin_beyond_recall = true; p.twin_rank = null; }), fx),
    ).toThrow();
    // db 非 beyond 但池里没有孪生
    expect(() =>
      loadGolden5CandDataset(mk((p) => { p.twin_source = "db"; p.twin_beyond_recall = false; p.twin_rank = 1; p.pool = [makeRow("zzz")]; }), fx),
    ).toThrow();
  });

  it("池内 record_id 重复 → 抛错", () => {
    const { fx, raw } = makeValidRaw(["a"]);
    const bad = JSON.parse(JSON.stringify(raw));
    bad.pairs[0].pool = [makeRow("dup"), makeRow("dup")];
    expect(() => loadGolden5CandDataset(bad, fx)).toThrow(/重复/);
  });

  it("validateGolden5CandPair 直接校验：缺字段 → 抛错", () => {
    expect(() => validateGolden5CandPair({ pid: "x" })).toThrow(/缺字段/);
  });
});
