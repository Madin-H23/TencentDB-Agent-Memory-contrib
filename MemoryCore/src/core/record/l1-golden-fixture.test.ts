// M1 D3 金标 fixture 加载器/schema/κ 测试。
// 覆盖：合法样本加载、schema 违规逐字段抛错（枚举/缺字段/类型/pid 重复/rank 一致性）、
//       agreementSubset 过滤（skip 剔除）、κ 计算与边际分布保护（pe 越界返回 null）。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  loadGoldenFixture,
  validateGoldenPair,
  agreementSubset,
  cohensKappa,
  finalAnswer,
  type GoldenPair,
} from "./golden-fixture.js";

const SAMPLE = join(__dirname, "__fixtures__", "m1-dedup-golden.sample.json");

function loadSample() {
  return loadGoldenFixture(JSON.parse(readFileSync(SAMPLE, "utf-8")));
}

const base = (): GoldenPair => ({
  pid: "t1",
  band: "0.85+",
  subset: "high-sim",
  sim: 0.9,
  rank_older: 3,
  rank_bucket: "top-5",
  type_older: "instruction",
  type_newer: "instruction",
  content_older: "甲",
  content_newer: "乙",
  answer_user: "merge",
});

describe("loadGoldenFixture：样本加载", () => {
  it("样本 fixture 合法加载，6 对、pid 唯一", () => {
    const f = loadSample();
    expect(f.schema).toBe("m1-dedup-golden/v1");
    expect(f.pairs).toHaveLength(6);
    expect(new Set(f.pairs.map((p) => p.pid)).size).toBe(6);
  });

  it("终裁缺省回落一判；显式 final 优先", () => {
    const f = loadSample();
    expect(finalAnswer(f.pairs[1]!)).toBe("merge"); // g002 无 final → user
    expect(finalAnswer(f.pairs[3]!)).toBe("store"); // g004 final=store（分歧终裁）
  });
});

describe("validateGoldenPair：schema 违规逐字段抛错", () => {
  it("缺字段抛错", () => {
    const p = base() as unknown as Record<string, unknown>;
    delete p.answer_user;
    expect(() => validateGoldenPair(p)).toThrow(/answer_user/);
  });

  it("枚举字段非法值抛错", () => {
    expect(() => validateGoldenPair({ ...base(), band: "0.9" })).toThrow(/band 非法/);
    expect(() => validateGoldenPair({ ...base(), subset: "neg-other" })).toThrow(/subset 非法/);
    expect(() => validateGoldenPair({ ...base(), rank_bucket: "top-3" })).toThrow(/rank_bucket 非法/);
    expect(() => validateGoldenPair({ ...base(), answer_user: "drop" })).toThrow(/answer_user 非法/);
    expect(() => validateGoldenPair({ ...base(), answer_judge2: "maybe" })).toThrow(/answer_judge2 非法/);
  });

  it("rank_older 与 bucket 一致性（-1 必须 absent；>0 不得 absent）", () => {
    expect(() => validateGoldenPair({ ...base(), rank_older: -1, rank_bucket: "top-5" })).toThrow(/rank_older=-1/);
    expect(() => validateGoldenPair({ ...base(), rank_older: 4, rank_bucket: "absent" })).toThrow(/bucket=absent/);
    expect(() => validateGoldenPair({ ...base(), rank_older: 0 })).toThrow(/rank_older/);
    expect(() => validateGoldenPair({ ...base(), rank_older: 1.5 })).toThrow(/rank_older/);
  });

  it("sim 边界：[0,1] 或 null；越界抛错", () => {
    expect(() => validateGoldenPair({ ...base(), sim: null })).not.toThrow();
    expect(() => validateGoldenPair({ ...base(), sim: 1.2 })).toThrow(/sim/);
    expect(() => validateGoldenPair({ ...base(), sim: -0.1 })).toThrow(/sim/);
  });

  it("fixture 级：schema 版本错、pid 重复、空 pairs 均抛错", () => {
    expect(() => loadGoldenFixture({ schema: "v2", created_at: "x", pairs: [base()] })).toThrow(/schema/);
    expect(() => loadGoldenFixture({ schema: "m1-dedup-golden/v1", created_at: "x", pairs: [] })).toThrow(/pairs/);
    expect(() =>
      loadGoldenFixture({
        schema: "m1-dedup-golden/v1",
        created_at: "x",
        pairs: [base(), { ...base(), pid: "t1" }],
      }),
    ).toThrow(/pid 重复/);
  });
});

describe("agreementSubset 与 cohensKappa", () => {
  it("skip 与未二判的对被剔除", () => {
    const sub = agreementSubset(loadSample().pairs);
    const pids = sub.map((p) => p.pid);
    expect(pids).not.toContain("g006"); // user=skip
    expect(pids).toEqual(["g001", "g002", "g003", "g004", "g005"]);
  });

  it("κ 可计算且落在 (-1,1]（样本含一对分歧）", () => {
    const k = cohensKappa(agreementSubset(loadSample().pairs));
    expect(k).not.toBeNull();
    expect(k!).toBeGreaterThan(-1);
    expect(k!).toBeLessThanOrEqual(1);
  });

  it("边际分布越界（pe<=0.2 或 >=0.8）时返回 null（κ 不诚实区间）", () => {
    // 双方全判 merge：po=1 但 pe=1 → null
    const allMerge: GoldenPair[] = Array.from({ length: 10 }, (_, i) => ({
      ...base(),
      pid: `m${i}`,
      answer_user: "merge" as const,
      answer_judge2: "merge" as const,
    }));
    expect(cohensKappa(allMerge)).toBeNull();
    // 空集 → null
    expect(cohensKappa([])).toBeNull();
  });
});
