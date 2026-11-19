/**
 * SPEC-E T02：planMerge 纯规划器测试。
 *
 * 覆盖：三段拼接、重复 v2 标题归一化、重复锚点、多重集守恒、META 重算、
 * 双帽、读视图、目标名/头部/归档/[DELETED]/域阈值拒绝、换序幂等键。
 * 全部无 fs；时间由调用方注入。
 */
import { describe, expect, it } from "vitest";
import { extractAnchorIds } from "../../utils/supersede.js";
import { isNormalizedSceneFilename } from "./filename-normalizer.js";
import {
  planMerge,
  deriveMergeKey,
  deriveMergeTargetName,
  type MergeSceneConfig,
  type MergeSceneInput,
  type PlanMergeOptions,
} from "./scene-merge.js";

const NOW = "2026-11-19T10:00:00.000Z";

const CONFIG: MergeSceneConfig = {
  mode: "shadow",
  pairCharLimit: 40_000,
  cCharLimit: 60_000,
  lockTtlMs: 300_000,
  heartbeatMs: 30_000,
  lockWaitMs: 5_000,
  journalDir: ".metadata/merge-journal",
  headScenes: ["head-scene.md"],
  maxPairsPerRound: 1,
};

function opts(overrides: Partial<PlanMergeOptions> = {}): PlanMergeOptions {
  return {
    config: CONFIG,
    now: NOW,
    target: "merged-scene.md",
    sceneCharCap: 500_000,
    existingSceneNames: [],
    ...overrides,
  };
}

interface SceneOpts {
  created?: string;
  updated?: string;
  summary?: string;
  heat?: number;
  gist?: string[];
  facts?: string[];
  activity?: string[];
  preamble?: string[];
}

/** 生成 v2 场景块原文：META + 可选序言 + 要点/事实/活动。 */
function sceneFile(o: SceneOpts = {}): string {
  const lines: string[] = [
    "-----META-START-----",
    "created: " + (o.created ?? "2026-11-01T00:00:00.000Z"),
    "updated: " + (o.updated ?? "2026-11-02T00:00:00.000Z"),
    "summary: " + (o.summary ?? "旧摘要"),
    "heat: " + String(o.heat ?? 1),
    "-----META-END-----",
    "",
  ];
  if (o.preamble && o.preamble.length > 0) {
    lines.push(...o.preamble, "");
  }
  lines.push(
    "## 要点",
    ...(o.gist ?? ["默认要点"]),
    "",
    "## 事实",
    ...(o.facts ?? ["- 默认事实"]),
    "",
    "## 活动",
    ...(o.activity ?? ["- 默认活动"]),
  );
  return lines.join("\n") + "\n";
}

function input(filename: string, raw: string): MergeSceneInput {
  return { filename, raw };
}

const A = input(
  "alpha.md",
  sceneFile({
    created: "2026-11-01T00:00:00.000Z",
    heat: 3,
    gist: ["甲要点"],
    facts: ["- 事实A（m_1795000000001_aaaaaaaa）"],
    activity: ["- 活动A"],
  }),
);
const B = input(
  "beta.md",
  sceneFile({
    created: "2026-11-02T00:00:00.000Z",
    heat: 7,
    gist: ["乙要点"],
    facts: ["- 事实B（m_1795000000002_bbbbbbbb）"],
    activity: ["- 活动B"],
  }),
);

describe("planMerge happy path", () => {
  it("拼接两段、重算 META、守恒锚点与正文行", () => {
    const r = planMerge(A, B, opts());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.target).toBe("merged-scene.md");
    expect(r.plan.c.meta.created).toBe("2026-11-01T00:00:00.000Z");
    expect(r.plan.c.meta.updated).toBe(NOW);
    expect(r.plan.c.meta.heat).toBe(7);
    expect(r.plan.c.meta.summary).toContain("甲要点");
    expect(r.plan.c.meta.summary).toContain("乙要点");
    expect(r.plan.metrics.anchorsIn).toBe(2);
    expect(r.plan.metrics.anchorsOut).toBe(2);
    expect(r.plan.metrics.anchorLost).toBe(0);
    expect(r.plan.metrics.bodyLinesLost).toBe(0);
    expect(extractAnchorIds(r.plan.c.raw).length).toBe(2);
    expect((r.plan.c.raw.match(/^## 要点$/gm) ?? []).length).toBe(1);
    expect((r.plan.c.raw.match(/^## 事实$/gm) ?? []).length).toBe(1);
    expect((r.plan.c.raw.match(/^## 活动$/gm) ?? []).length).toBe(1);
    expect(r.plan.c.raw).toContain("甲要点");
    expect(r.plan.c.raw).toContain("乙要点");
  });

  it("换序调用 key 与 C 一致（规范化拼接序）", () => {
    const ab = planMerge(A, B, opts());
    const ba = planMerge(B, A, opts());
    expect(ab.ok && ba.ok).toBe(true);
    if (!ab.ok || !ba.ok) return;
    expect(ba.plan.key).toBe(ab.plan.key);
    expect(ba.plan.c.raw).toBe(ab.plan.c.raw);
    expect(ba.plan.concatOrder).toBe("alpha.md>beta.md");
  });

  it("key 不含 target；同输入换 target 不产生第二个 key", () => {
    const r1 = planMerge(A, B, opts());
    const r2 = planMerge(A, B, opts({ target: "other-scene.md" }));
    expect(r1.ok && r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;
    expect(r2.plan.key).toBe(r1.plan.key);
    expect(r2.plan.target).toBe("other-scene.md");
  });

  it("deriveMergeKey 对换序稳定", () => {
    const k1 = deriveMergeKey(A, B, "alpha.md>beta.md");
    const k2 = deriveMergeKey(B, A, "alpha.md>beta.md");
    expect(k2).toBe(k1);
    expect(k1).toMatch(/^[0-9a-f]{64}$/);
  });

  it("A 的序言保留，重复 v2 标题归一化", () => {
    const aRaw = sceneFile({
      preamble: ["A 的序言行"],
      facts: ["- 事实A（m_1795000000001_aaaaaaaa）"],
    }).replace("## 活动", "## 活动\n- 前段活动\n## 活动");
    const r = planMerge(input("alpha.md", aRaw), B, opts());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.c.raw).toContain("A 的序言行");
    expect(r.plan.c.raw).toContain("- 前段活动");
    expect((r.plan.c.raw.match(/^## 活动$/gm) ?? []).length).toBe(1);
  });

  it("输入自身重复锚点全部保留", () => {
    const aRaw = sceneFile({
      facts: [
        "- 事实A1（m_1795000000001_aaaaaaaa）",
        "- 事实A2（m_1795000000001_aaaaaaaa）",
      ],
    });
    const bRaw = sceneFile({ facts: ["- 事实B（m_1795000000001_aaaaaaaa）"] });
    const r = planMerge(input("alpha.md", aRaw), input("beta.md", bRaw), opts());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.metrics.anchorsIn).toBe(3);
    expect(r.plan.metrics.anchorsOut).toBe(3);
    expect(r.plan.metrics.duplicateAnchorIds).toBe(1);
    expect(extractAnchorIds(r.plan.c.raw).length).toBe(3);
  });
});

describe("planMerge 布局拒绝", () => {
  it("B 的非空序言拒绝（会丢内容）", () => {
    const bRaw = sceneFile({ preamble: ["B 的序言"] });
    const r = planMerge(A, input("beta.md", bRaw), opts());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.rejection.code).toBe("unsupported_layout");
  });

  it.each([
    ["首个 v2 段不是要点", sceneFile().replace(/^## 要点$/m, "## 事实")],
    ["缺少活动段", sceneFile().replace(/\n## 活动[\s\S]*$/, "\n")],
    ["已闭合段重入", sceneFile() + "\n## 事实\n- 后置事实\n"],
    ["非 v2 文件", "纯文本，没有 v2 标题"],
  ])("拒绝布局：%s", (_name, raw) => {
    const r = planMerge(A, input("beta.md", raw), opts());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.rejection.code).toBe("unsupported_layout");
  });
});

describe("planMerge 输入拒绝", () => {
  it("归档文件拒绝", () => {
    const r = planMerge(A, input("beta-archive.md", B.raw), opts());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.rejection.code).toBe("archive_input");
  });

  it("META archive:true 拒绝", () => {
    const raw = B.raw.replace("heat: 7", "heat: 7\narchive: true");
    const r = planMerge(A, input("beta.md", raw), opts());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.rejection.code).toBe("archive_input");
  });

  it("[DELETED] 内容拒绝", () => {
    const raw = "-----META-START-----\ncreated: 2026-11-01T00:00:00.000Z\nupdated: 2026-11-01T00:00:00.000Z\nsummary: x\nheat: 1\n-----META-END-----\n\n[DELETED]\n";
    const r = planMerge(A, input("beta.md", raw), opts());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.rejection.code).toBe("deleted_input");
  });

  it("空正文拒绝", () => {
    const raw = "-----META-START-----\ncreated: 2026-11-01T00:00:00.000Z\nupdated: 2026-11-01T00:00:00.000Z\nsummary: x\nheat: 1\n-----META-END-----\n\n";
    const r = planMerge(A, input("beta.md", raw), opts());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.rejection.code).toBe("empty_input");
  });

  it("同一文件名拒绝", () => {
    const r = planMerge(A, input("alpha.md", B.raw), opts());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.rejection.code).toBe("invalid_input");
  });

  it("含路径分隔符的输入文件名拒绝", () => {
    const r = planMerge(A, input("dir/beta.md", B.raw), opts());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.rejection.code).toBe("invalid_input");
  });

  it("头部场景拒绝", () => {
    const r = planMerge(A, input("head-scene.md", B.raw), opts());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.rejection.code).toBe("head_scene");
  });
});

describe("planMerge target 拒绝", () => {
  it.each([
    ["未规范化名", "Merged Scene.md", "target_invalid"],
    ["归档后缀", "merged-archive.md", "target_invalid"],
    ["Windows 保留名", "con.md", "target_invalid"],
    ["与输入同名", "alpha.md", "target_conflict"],
  ])("拒绝 target：%s", (_name, target, code) => {
    const r = planMerge(A, B, opts({ target }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.rejection.code).toBe(code);
  });

  it("target 已存在拒绝", () => {
    const r = planMerge(A, B, opts({ existingSceneNames: ["merged-scene.md"] }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.rejection.code).toBe("target_exists");
  });
});

describe("planMerge 阈值与选项", () => {
  it("A+B 超 40K 拒绝", () => {
    const bigA = input("alpha.md", sceneFile({ facts: ["- " + "a".repeat(20_000)] }));
    const bigB = input("beta.md", sceneFile({ facts: ["- " + "b".repeat(20_000)] }));
    const r = planMerge(bigA, bigB, opts());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.rejection.code).toBe("over_domain");
  });

  it("C 超 cCharLimit 拒绝", () => {
    const aRaw = sceneFile({ facts: ["- " + "a".repeat(19_800)] });
    const bRaw = sceneFile({ facts: ["- " + "b".repeat(19_800)] });
    const r = planMerge(input("alpha.md", aRaw), input("beta.md", bRaw), opts({
      config: { ...CONFIG, cCharLimit: 39_500 },
    }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.rejection.code).toBe("over_c_char_limit");
  });

  it("C 超 sceneCharCap*0.9 拒绝", () => {
    const aRaw = sceneFile({ facts: ["- " + "a".repeat(4_600)] });
    const bRaw = sceneFile({ facts: ["- " + "b".repeat(4_600)] });
    const r = planMerge(input("alpha.md", aRaw), input("beta.md", bRaw), opts({ sceneCharCap: 10_000 }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.rejection.code).toBe("over_c_char_limit");
  });

  it("C 默认读视图超 40K 拒绝", () => {
    const aRaw = sceneFile({ facts: ["- " + "a".repeat(19_940)] });
    const bRaw = sceneFile({ facts: ["- " + "b".repeat(19_940)] });
    const r = planMerge(input("alpha.md", aRaw), input("beta.md", bRaw), opts());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.rejection.code).toBe("over_read_view");
  });

  it.each([
    ["now 非法", { now: "not-a-time" }],
    ["sceneCharCap=0", { sceneCharCap: 0 }],
  ])("拒绝选项：%s", (_name, override) => {
    const r = planMerge(A, B, opts(override as Partial<PlanMergeOptions>));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.rejection.code).toBe("invalid_options");
  });
});

describe("planMerge 边界值", () => {
  const META = [
    "-----META-START-----",
    "created: 2026-11-01T00:00:00.000Z",
    "updated: 2026-11-01T00:00:00.000Z",
    "summary: 边界",
    "heat: 1",
    "-----META-END-----",
  ].join("\n");

  /** 构造正文长度精确为 n 的 v2 场景：活动段承担填充，读视图保持很小。 */
  function sceneOfContentLength(n: number): string {
    const head = "## 要点\n边界要点\n\n## 事实\n- 边界事实\n\n## 活动\n";
    const prefix = "- ";
    const pad = n - head.length - prefix.length;
    if (pad < 1) throw new Error("n too small");
    return META + "\n\n" + head + prefix + "a".repeat(pad) + "\n";
  }

  it("A+B 恰好 40000 通过域上限", () => {
    const a = input("alpha.md", sceneOfContentLength(20_000));
    const b = input("beta.md", sceneOfContentLength(20_000));
    const r = planMerge(a, b, opts());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.metrics.pairChars).toBe(40_000);
  });

  it("A+B 40001 被域上限拒绝", () => {
    const a = input("alpha.md", sceneOfContentLength(20_000));
    const b = input("beta.md", sceneOfContentLength(20_001));
    const r = planMerge(a, b, opts());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.rejection.code).toBe("over_domain");
  });

  it("cap*0.9 内通过、越界拒绝", () => {
    const a = input("alpha.md", sceneOfContentLength(4_200));
    const b = input("beta.md", sceneOfContentLength(4_200));
    const ok = planMerge(a, b, opts({ sceneCharCap: 10_000 }));
    expect(ok.ok).toBe(true);

    const a2 = input("alpha.md", sceneOfContentLength(4_600));
    const b2 = input("beta.md", sceneOfContentLength(4_600));
    const bad = planMerge(a2, b2, opts({ sceneCharCap: 10_000 }));
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.rejection.code).toBe("over_c_char_limit");
  });

  it("deriveMergeTargetName：换序稳定、规范化且可读", () => {
    const a = "AIHOT晨报-自动化发送与免费模型观察.md";
    const b = "技术研究-Trending日报自动化与开源生态.md";
    const name = deriveMergeTargetName(a, b);
    expect(name).toBe(deriveMergeTargetName(b, a));
    expect(name.endsWith(".md")).toBe(true);
    expect(name).toContain("合并");
    expect(isNormalizedSceneFilename(name)).toBe(true);
  });
});
