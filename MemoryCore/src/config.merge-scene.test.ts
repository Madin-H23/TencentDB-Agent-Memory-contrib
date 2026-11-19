// SPEC-E：persona.mergeScene 配置解析（Stage 1 基础字段 + Stage 2 candidatePairs）。
// 缺省/false=off（现有 L2 行为逐字节不变）；true=shadow+默认值；on 在 Stage 1/2
// 解析期显式拒绝；非法 mode/阈值/路径/禁入名单/cap 组合 → throw（不静默回落）。
import { describe, expect, it } from "vitest";
import { parseConfig } from "./config.js";

describe("parseConfig：persona.mergeScene 解析", () => {
  it("缺省/false → undefined（off，行为不变）", () => {
    expect(parseConfig({}).persona.mergeScene).toBeUndefined();
    expect(parseConfig({ persona: { mergeScene: false } }).persona.mergeScene).toBeUndefined();
    expect(parseConfig({ persona: { mergeScene: null } }).persona.mergeScene).toBeUndefined();
  });

  it("true → shadow + 全默认值", () => {
    expect(parseConfig({ persona: { mergeScene: true } }).persona.mergeScene).toEqual({
      mode: "shadow",
      pairCharLimit: 40_000,
      cCharLimit: 60_000,
      lockTtlMs: 300_000,
      heartbeatMs: 30_000,
      lockWaitMs: 5_000,
      journalDir: ".metadata/merge-journal",
      headScenes: [
        "技术研究-TDAI记忆系统治理与观测.md",
        "PR战役3.0-分片作战.md",
        "PR战役3.0-S3S4-代码与Agent分片.md",
        "技术研究-it-ops架构学习.md",
      ],
      maxPairsPerRound: 1,
      candidatePairs: [],
    });
  });

  it("对象：mode 缺省 off；字段透传并回落默认值", () => {
    expect(parseConfig({ persona: { mergeScene: {} } }).persona.mergeScene).toMatchObject({
      mode: "off",
      pairCharLimit: 40_000,
      cCharLimit: 60_000,
    });
    expect(
      parseConfig({
        persona: {
          mergeScene: {
            mode: "shadow",
            pairCharLimit: 30_000,
            cCharLimit: 50_000,
            lockTtlMs: 120_000,
            heartbeatMs: 10_000,
            lockWaitMs: 0,
            journalDir: "meta/merge",
            headScenes: ["头部-甲.md"],
            maxPairsPerRound: 2,
            candidatePairs: [{ a: "技术研究-a.md", b: "技术研究-b.md" }],
          },
        },
      }).persona.mergeScene,
    ).toEqual({
      mode: "shadow",
      pairCharLimit: 30_000,
      cCharLimit: 50_000,
      lockTtlMs: 120_000,
      heartbeatMs: 10_000,
      lockWaitMs: 0,
      journalDir: "meta/merge",
      headScenes: ["头部-甲.md"],
      maxPairsPerRound: 2,
      candidatePairs: [{ a: "技术研究-a.md", b: "技术研究-b.md" }],
    });
  });

  it("headScenes 规范化：空格转连字符并补 .md", () => {
    const cfg = parseConfig({
      persona: { mergeScene: { headScenes: [" 技术研究 TDAI治理 "] } },
    }).persona.mergeScene;
    expect(cfg?.headScenes).toEqual(["技术研究-TDAI治理.md"]);
  });

  it("mode=on 解析放行，但必须带非空 candidatePairs（Stage 3 白名单）", () => {
    expect(() => parseConfig({ persona: { mergeScene: { mode: "on" } } })).toThrow(/candidatePairs/);
    const cfg = parseConfig({
      persona: {
        sceneCharCap: 500_000,
        mergeScene: { mode: "on", candidatePairs: [{ a: "技术研究-a.md", b: "技术研究-b.md" }] },
      },
    }).persona.mergeScene!;
    expect(cfg.mode).toBe("on");
    expect(cfg.candidatePairs).toHaveLength(1);
  });

  it("mode=on 时 maxPairsPerRound 必须为 1", () => {
    expect(() =>
      parseConfig({
        persona: {
          sceneCharCap: 500_000,
          mergeScene: {
            mode: "on",
            candidatePairs: [{ a: "技术研究-a.md", b: "技术研究-b.md" }],
            maxPairsPerRound: 2,
          },
        },
      }),
    ).toThrow(/maxPairsPerRound/);
    expect(
      parseConfig({
        persona: {
          sceneCharCap: 500_000,
          mergeScene: {
            mode: "on",
            candidatePairs: [{ a: "技术研究-a.md", b: "技术研究-b.md" }],
            maxPairsPerRound: 1,
          },
        },
      }).persona.mergeScene?.maxPairsPerRound,
    ).toBe(1);
  });

  it("非法 mode / 类型 → throw", () => {
    expect(() => parseConfig({ persona: { mergeScene: { mode: "auto" } } })).toThrow(/mergeScene/);
    expect(() => parseConfig({ persona: { mergeScene: 1 } })).toThrow(/mergeScene/);
    expect(() => parseConfig({ persona: { mergeScene: "on" } })).toThrow(/mergeScene/);
    expect(() => parseConfig({ persona: { mergeScene: [] } })).toThrow(/mergeScene/);
  });

  it("非法阈值组合 → throw", () => {
    expect(() => parseConfig({ persona: { mergeScene: { pairCharLimit: 0 } } })).toThrow(/pairCharLimit/);
    expect(() => parseConfig({ persona: { mergeScene: { pairCharLimit: -1 } } })).toThrow(/pairCharLimit/);
    expect(() => parseConfig({ persona: { mergeScene: { pairCharLimit: 1.5 } } })).toThrow(/pairCharLimit/);
    expect(() => parseConfig({ persona: { mergeScene: { cCharLimit: 40_000 } } })).toThrow(/cCharLimit/);
    expect(() => parseConfig({ persona: { mergeScene: { cCharLimit: 60_001 } } })).toThrow(/cCharLimit/);
    expect(() => parseConfig({ persona: { mergeScene: { lockTtlMs: 10_000, heartbeatMs: 10_000 } } })).toThrow(
      /heartbeatMs/,
    );
    expect(() => parseConfig({ persona: { mergeScene: { lockWaitMs: -1 } } })).toThrow(/lockWaitMs/);
    expect(() => parseConfig({ persona: { mergeScene: { maxPairsPerRound: 0 } } })).toThrow(/maxPairsPerRound/);
  });

  it("非法 journalDir / headScenes → throw", () => {
    expect(() => parseConfig({ persona: { mergeScene: { journalDir: "/abs/path" } } })).toThrow(/journalDir/);
    expect(() => parseConfig({ persona: { mergeScene: { journalDir: "C:\\abs" } } })).toThrow(/journalDir/);
    expect(() => parseConfig({ persona: { mergeScene: { journalDir: "../escape" } } })).toThrow(/journalDir/);
    expect(() => parseConfig({ persona: { mergeScene: { journalDir: "" } } })).toThrow(/journalDir/);
    expect(() => parseConfig({ persona: { mergeScene: { headScenes: [] } } })).toThrow(/headScenes/);
    expect(() => parseConfig({ persona: { mergeScene: { headScenes: ["a/b.md"] } } })).toThrow(/headScenes/);
    expect(() => parseConfig({ persona: { mergeScene: { headScenes: [1] } } })).toThrow(/headScenes/);
  });

  it("mode 非 off 且 sceneCharCap<=0 → fail-closed", () => {
    expect(() =>
      parseConfig({ persona: { sceneCharCap: 0, mergeScene: { mode: "shadow" } } }),
    ).toThrow(/sceneCharCap/);
    expect(() =>
      parseConfig({ persona: { sceneCharCap: -1, mergeScene: true } }),
    ).toThrow(/sceneCharCap/);
    // off 时不因 cap 关闭而拒绝（配置可先落，后续再开模式）
    expect(
      parseConfig({ persona: { sceneCharCap: 0, mergeScene: { mode: "off" } } }).persona.mergeScene?.mode,
    ).toBe("off");
  });
});

describe("parseConfig：persona.mergeScene.candidatePairs", () => {
  it("缺省为空数组，合法对按序透传", () => {
    expect(parseConfig({ persona: { mergeScene: true } }).persona.mergeScene?.candidatePairs).toEqual([]);
    const parsed = parseConfig({
      persona: {
        mergeScene: {
          mode: "shadow",
          candidatePairs: [
            { a: "技术研究-a.md", b: "技术研究-b.md" },
            { a: "技术研究-c.md", b: "技术研究-d.md" },
          ],
        },
      },
    }).persona.mergeScene!;
    expect(parsed.candidatePairs).toEqual([
      { a: "技术研究-a.md", b: "技术研究-b.md" },
      { a: "技术研究-c.md", b: "技术研究-d.md" },
    ]);
  });

  it("candidatePairs 含头部场景拒绝（白名单不得绕过禁入）", () => {
    expect(() =>
      parseConfig({
        persona: {
          mergeScene: {
            mode: "shadow",
            candidatePairs: [{ a: "技术研究-TDAI记忆系统治理与观测.md", b: "技术研究-x.md" }],
          },
        },
      }).persona.mergeScene,
    ).toThrow(/candidatePairs.*头部/);
  });

  it("最多 8 对；超过即拒绝", () => {
    const pairs = Array.from({ length: 8 }, (_, i) => ({
      a: "技术研究-a" + String(i) + ".md",
      b: "技术研究-b" + String(i) + ".md",
    }));
    expect(
      parseConfig({ persona: { mergeScene: { mode: "shadow", candidatePairs: pairs } } }).persona
        .mergeScene?.candidatePairs,
    ).toHaveLength(8);
    expect(() =>
      parseConfig({
        persona: {
          mergeScene: {
            mode: "shadow",
            candidatePairs: [...pairs, { a: "技术研究-x.md", b: "技术研究-y.md" }],
          },
        },
      }),
    ).toThrow(/candidatePairs/);
  });

  it("非法形状/路径/归档/自配对/重复对均拒绝", () => {
    const withPairs = (candidatePairs: unknown): (() => unknown) => () =>
      parseConfig({ persona: { mergeScene: { mode: "shadow", candidatePairs } } });
    expect(withPairs("nope")).toThrow(/candidatePairs/);
    expect(withPairs([{ a: "技术研究-a.md" }])).toThrow(/candidatePairs/);
    expect(withPairs([{ a: "技术研究-a.md", b: "a/b.md" }])).toThrow(/candidatePairs/);
    expect(withPairs([{ a: "技术研究-a-archive.md", b: "技术研究-b.md" }])).toThrow(/candidatePairs/);
    expect(withPairs([{ a: "技术研究-a.md", b: "技术研究-a.md" }])).toThrow(/candidatePairs/);
    expect(
      withPairs([
        { a: "技术研究-a.md", b: "技术研究-b.md" },
        { a: "技术研究-b.md", b: "技术研究-a.md" },
      ]),
    ).toThrow(/candidatePairs/);
  });
});
