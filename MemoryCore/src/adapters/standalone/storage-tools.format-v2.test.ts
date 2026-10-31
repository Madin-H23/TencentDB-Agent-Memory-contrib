// 票⑤（exp/p1-5-scene-format-v2）：storage 工厂（createStorageTools）的 v2 双层化。
// 覆盖：off 逐字节钉（schema 无新参/行为与基线一致/存储终态无同步）、on 读视图
// （默认两层/includeArchive 审计/混合语料）、写入按层落盘（要点→META 同步+metric）、
// 票⑥失效交互（过滤→窗口口径）、C 帽交互（帽仍整文件）、L3 豁免、畸形输入。
import { describe, expect, it } from "vitest";
import type { StorageAdapter } from "../../core/storage/adapter.js";
import { createStorageTools } from "./storage-tools.js";

interface LoggerSpy {
  debug?: (m: string) => void;
  info?: (m: string) => void;
  warn: (m: string) => void;
  error: (m: string) => void;
  infos: string[];
  warns: string[];
}

function makeLogger(): LoggerSpy {
  const infos: string[] = [];
  const warns: string[] = [];
  return {
    info: (m: string) => infos.push(m),
    warn: (m: string) => warns.push(m),
    error: (m: string) => void m,
    infos,
    warns,
  };
}

function makeStorage(prefix: string, files: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(files).map(([k, v]) => [`${prefix}${k}`, v]));
  const mock = {
    readFile: async (key: string) => store.get(key) ?? null,
    writeFile: async (key: string, content: string) => {
      store.set(key, content);
    },
    readdirNames: async (p: string, suffix?: string) =>
      [...store.keys()]
        .filter((k) => k.startsWith(p) && (suffix ? k.endsWith(suffix) : true))
        .map((k) => k.slice(p.length)),
    mkdir: async () => {},
  };
  return { mock: mock as unknown as StorageAdapter, store };
}

function parseOut(out: string): Record<string, unknown> {
  return JSON.parse(out) as Record<string, unknown>;
}

type Exec = (a: unknown) => Promise<string>;

const PREFIX = "scene_blocks/";

const V2_FILE = [
  "-----META-START-----",
  "created: 2026-10-01T00:00:00.000Z",
  "updated: 2026-10-31T00:00:00.000Z",
  "summary: 旧的流水账摘要特别长".repeat(20),
  "heat: 3",
  "-----META-END-----",
  "",
  "## 要点",
  "记忆系统 P1 自迭代要点。",
  "",
  "## 事实",
  "- 事实一 m_1787881381525_2eee472e",
  "- 事实二 m_1788449899823_245dfba6",
  "",
  "## 活动",
  "### 批次 2026-10-30",
  "叙事叙事叙事。",
].join("\n");

const V1_FILE = "-----META-START-----\nsummary: v1 摘要\n-----META-END-----\n## 用户核心特征\nv1 正文 m_1787881381525_2eee472e";

describe("storage-tools v2 off 钉", () => {
  it("off：read schema 无 includeArchive；v2/v1 文件原文逐字节返回", async () => {
    const { mock } = makeStorage(PREFIX, { "v2.md": V2_FILE, "v1.md": V1_FILE });
    const { read } = createStorageTools(mock, PREFIX, undefined, "t", 0, false, false);
    expect(JSON.stringify(read.inputSchema)).not.toContain("includeArchive");
    expect(JSON.stringify(read.inputSchema)).not.toContain("includeInvalidated");
    const rd = read.execute as unknown as (a: { path: string }) => Promise<string>;
    expect(await rd({ path: "v2.md" })).toBe(V2_FILE);
    expect(await rd({ path: "v1.md" })).toBe(V1_FILE);
  });

  it("off：write v2 内容照原样落盘（无 META 同步、无 metric）", async () => {
    const { mock, store } = makeStorage(PREFIX, {});
    const logger = makeLogger();
    const { write } = createStorageTools(mock, PREFIX, logger, "t", 0, false, false);
    const out = await (write.execute as unknown as Exec)({ path: "a.md", content: V2_FILE });
    expect(parseOut(out).success).toBe(true);
    expect(store.get(`${PREFIX}a.md`)).toBe(V2_FILE); // summary 未被同步
    expect(logger.infos.some((m) => m.includes("metric="))).toBe(false);
  });

  it("off（缺省第 6/7 参）与显式 false 逐字节同形（双写钉）", async () => {
    const { mock } = makeStorage(PREFIX, { "v2.md": V2_FILE });
    const a = createStorageTools(mock, PREFIX, undefined, "t", 0);
    const b = createStorageTools(mock, PREFIX, undefined, "t", 0, false, false);
    expect(JSON.stringify(a.read.inputSchema)).toBe(JSON.stringify(b.read.inputSchema));
    expect(a.read.description).toBe(b.read.description);
    const rd = (t: typeof a.read) => t.execute as unknown as (a: { path: string }) => Promise<string>;
    expect(await rd(a.read)({ path: "v2.md" })).toBe(await rd(b.read)({ path: "v2.md" }));
  });

  it("L3 豁免：prefix 为空时 v2 on 也不启用（persona 不受层路由影响）", async () => {
    const { mock, store } = makeStorage("", { "persona.md": V2_FILE });
    const { read } = createStorageTools(mock, "", undefined, "t", 0, true, true);
    expect(JSON.stringify(read.inputSchema)).not.toContain("includeArchive");
    const rd = read.execute as unknown as (a: { path: string }) => Promise<string>;
    expect(await rd({ path: "persona.md" })).toBe(V2_FILE);
    expect(store.get("persona.md")).toBe(V2_FILE);
  });
});

describe("storage-tools v2 read：默认两层视图", () => {
  it("on：默认 read 只返回 META+要点+事实（活动段折叠+标注行）", async () => {
    const { mock } = makeStorage(PREFIX, { "v2.md": V2_FILE });
    const { read } = createStorageTools(mock, PREFIX, undefined, "t", 0, false, true);
    expect(JSON.stringify(read.inputSchema)).toContain("includeArchive");
    expect(String(read.description)).toContain("includeArchive");
    const out = await (read.execute as unknown as (a: { path: string }) => Promise<string>)({ path: "v2.md" });
    expect(out).toContain("## 要点");
    expect(out).toContain("## 事实");
    expect(out).toContain("m_1787881381525_2eee472e");
    expect(out).not.toContain("## 活动");
    expect(out).not.toContain("叙事叙事叙事");
    // 默认视图 = 原文剥离活动段的逐字节子集（体积严格小于全文）
    expect(out.length).toBeLessThan(V2_FILE.length);
  });

  it("on：includeArchive:true → 全量原文逐字节（审计面）", async () => {
    const { mock } = makeStorage(PREFIX, { "v2.md": V2_FILE });
    const { read } = createStorageTools(mock, PREFIX, undefined, "t", 0, false, true);
    const out = await (read.execute as unknown as (a: { path: string; includeArchive?: boolean }) => Promise<string>)({ path: "v2.md", includeArchive: true });
    expect(out).toBe(V2_FILE);
  });

  it("on：混合语料——v1 文件默认 read 逐字节不变形不报错", async () => {
    const { mock } = makeStorage(PREFIX, { "v2.md": V2_FILE, "v1.md": V1_FILE });
    const { read } = createStorageTools(mock, PREFIX, undefined, "t", 0, false, true);
    const rd = read.execute as unknown as (a: { path: string }) => Promise<string>;
    expect(await rd({ path: "v1.md" })).toBe(V1_FILE);
    expect((await rd({ path: "v2.md" })).length).toBeLessThan(V2_FILE.length);
  });

  it("on：窗口作用于折叠后视图（过滤→窗口）——offset=0 limit 小段不触及活动区", async () => {
    const { mock } = makeStorage(PREFIX, { "v2.md": V2_FILE });
    const { read } = createStorageTools(mock, PREFIX, undefined, "t", 0, false, true);
    const out = await (read.execute as unknown as (a: { path: string; offset?: number; limit?: number }) => Promise<string>)({ path: "v2.md", offset: 0, limit: 80 });
    expect(out).not.toContain("## 活动");
    expect(out).toContain("[... omitted");
  });
});

describe("storage-tools v2 write/edit：按层落盘", () => {
  it("on：write v2 内容 → META.summary 被 `## 要点` 覆盖 + metric=l2_format_v2", async () => {
    const { mock, store } = makeStorage(PREFIX, {});
    const logger = makeLogger();
    const { write } = createStorageTools(mock, PREFIX, logger, "t", 0, false, true);
    const out = await (write.execute as unknown as Exec)({ path: "a.md", content: V2_FILE });
    expect(parseOut(out).success).toBe(true);
    const persisted = store.get(`${PREFIX}a.md`)!;
    expect(persisted).toContain("summary: 记忆系统 P1 自迭代要点。");
    expect(persisted).toContain("## 活动"); // 活动区不受同步影响
    expect(logger.infos.filter((m) => m.includes("metric=l2_format_v2 value=1"))).toHaveLength(1);
    expect(logger.infos.some((m) => m.includes("path=a.md"))).toBe(true);
  });

  it("on：edit 后像同步幂等——已同步文档 edit 无关段落零字节变化", async () => {
    const synced = V2_FILE.replace(/^summary: .*$/m, "summary: 记忆系统 P1 自迭代要点。");
    const { mock, store } = makeStorage(PREFIX, { "a.md": synced });
    const { edit } = createStorageTools(mock, PREFIX, undefined, "t", 0, false, true);
    const out = await (edit.execute as unknown as Exec)({
      path: "a.md",
      edits: [{ oldText: "- 事实一 m_1787881381525_2eee472e", newText: "- 事实一改 m_1787881381525_2eee472e" }],
    });
    expect(parseOut(out).success).toBe(true);
    expect(store.get(`${PREFIX}a.md`)).toBe(synced.replace("事实一", "事实一改"));
  });

  it("on：write v1 内容原样落盘（非 v2 不同步、不打 metric）", async () => {
    const { mock, store } = makeStorage(PREFIX, {});
    const logger = makeLogger();
    const { write } = createStorageTools(mock, PREFIX, logger, "t", 0, false, true);
    await (write.execute as unknown as Exec)({ path: "v1.md", content: V1_FILE });
    expect(store.get(`${PREFIX}v1.md`)).toBe(V1_FILE);
    expect(logger.infos.some((m) => m.includes("metric=l2_format_v2"))).toBe(false);
  });

  it("on：空要点段 → 不清空旧 summary（保守不破坏）", async () => {
    const doc = "-----META-START-----\nsummary: 旧摘要\n-----META-END-----\n## 要点\n\n## 事实\nf m_1787881381525_2eee472e";
    const { mock, store } = makeStorage(PREFIX, {});
    const { write } = createStorageTools(mock, PREFIX, undefined, "t", 0, false, true);
    await (write.execute as unknown as Exec)({ path: "a.md", content: doc });
    expect(store.get(`${PREFIX}a.md`)).toBe(doc);
  });

  it("on：[DELETED] 软删流不走同步/metric", async () => {
    const { mock, store } = makeStorage(PREFIX, { "a.md": "纯叙事" });
    const logger = makeLogger();
    const { write } = createStorageTools(mock, PREFIX, logger, "t", 0, false, true);
    await (write.execute as unknown as Exec)({ path: "a.md", content: "[DELETED]" });
    expect(store.get(`${PREFIX}a.md`)).toBe("[DELETED]");
    expect(logger.infos.some((m) => m.includes("metric="))).toBe(false);
  });
});

describe("storage-tools v2 × 票⑥ 失效交互", () => {
  const V2_DEAD = V2_FILE.replace(
    "- 事实一 m_1787881381525_2eee472e",
    "[SUPERSEDED 2026-10-31T10:00:00.000Z] - 事实一 m_1787881381525_2eee472e",
  );

  it("on+⑥ on：默认 read = 两层且失效行被滤；includeInvalidated 恢复失效行", async () => {
    const { mock } = makeStorage(PREFIX, { "v2.md": V2_DEAD });
    const { read } = createStorageTools(mock, PREFIX, undefined, "t", 0, true, true);
    const rd = read.execute as unknown as (a: { path: string; includeInvalidated?: boolean }) => Promise<string>;
    const def = await rd({ path: "v2.md" });
    expect(def).not.toContain("[SUPERSEDED");
    expect(def).not.toContain("## 活动");
    expect(def).toContain("事实二");
    const audit = await rd({ path: "v2.md", includeInvalidated: true });
    expect(audit).toContain("[SUPERSEDED");
    expect(audit).not.toContain("## 活动");
  });

  it("on+⑥ on：includeArchive+includeInvalidated 双旗 = 原文逐字节（全量审计）", async () => {
    const { mock } = makeStorage(PREFIX, { "v2.md": V2_DEAD });
    const { read } = createStorageTools(mock, PREFIX, undefined, "t", 0, true, true);
    const out = await (read.execute as unknown as (a: { path: string; includeInvalidated?: boolean; includeArchive?: boolean }) => Promise<string>)({ path: "v2.md", includeInvalidated: true, includeArchive: true });
    expect(out).toBe(V2_DEAD);
  });

  it("on+⑥ on：失效守卫仍生效——edit 丢锚拒绝不落盘", async () => {
    const { mock, store } = makeStorage(PREFIX, { "v2.md": V2_FILE });
    const { edit } = createStorageTools(mock, PREFIX, undefined, "t", 0, true, true);
    const out = await (edit.execute as unknown as Exec)({
      path: "v2.md",
      edits: [{ oldText: "- 事实一 m_1787881381525_2eee472e\n", newText: "" }],
    });
    expect(parseOut(out).error).toBe("anchor_loss_forbidden");
    expect(store.get(`${PREFIX}v2.md`)).toBe(V2_FILE);
  });
});

describe("storage-tools v2 × C 帽交互", () => {
  it("on：帽仍按整文件后像——活动区超帽照拒（拒绝体无 v2 附加键）", async () => {
    const archive = "## 活动\n" + "x".repeat(200);
    const doc = `-----META-START-----\nsummary: s\n-----META-END-----\n## 要点\ng\n## 事实\nf m_1787881381525_2eee472e\n${archive}`;
    const { mock } = makeStorage(PREFIX, {});
    const { write } = createStorageTools(mock, PREFIX, undefined, "t", 100, false, true);
    const out = await (write.execute as unknown as Exec)({ path: "a.md", content: doc });
    const r = parseOut(out);
    expect(r.error).toBe("over_scene_char_cap");
    expect(Object.keys(r).sort()).toEqual(["cap", "chars", "error", "hint", "overflow"]);
  });

  it("on：两层内容（要点+事实）远小于帽 → 放行落盘", async () => {
    const doc = "-----META-START-----\nsummary: s\n-----META-END-----\n## 要点\ng\n## 事实\nf m_1787881381525_2eee472e\n## 活动\nx".repeat(1);
    const { mock, store } = makeStorage(PREFIX, {});
    const { write } = createStorageTools(mock, PREFIX, undefined, "t", 500, false, true);
    const out = await (write.execute as unknown as Exec)({ path: "a.md", content: doc });
    expect(parseOut(out).success).toBe(true);
    expect(store.get(`${PREFIX}a.md`)).toContain("## 活动");
  });
});
