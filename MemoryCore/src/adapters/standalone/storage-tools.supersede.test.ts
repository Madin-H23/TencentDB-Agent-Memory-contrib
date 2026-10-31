// 票⑥（exp/p1-6-supersede-inval）：storage 工厂（createStorageTools）的显式失效语义。
// off 钉（schema 无新参 + 行为与基线一致）、on 全路径（read 过滤/锚点守卫/[DELETED]
// 重定位/失效帽排除/metric 锚点）、L3 豁免、畸形输入。
import { describe, expect, it } from "vitest";
import type { StorageAdapter } from "../../core/storage/adapter.js";
import { createStorageTools } from "./storage-tools.js";

const MARK = "[SUPERSEDED 2026-10-31T10:00:00.000Z]";

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

/** 最小 StorageAdapter mock：内存 Map + readdirNames（与在役键序约定一致）。 */
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

const PREFIX = "scene_blocks/";
const SCENE_A = "## 叙事\n- 旧事实 m_1787881381525_2eee472e\n尾行";

describe("storage-tools read：off 钉 / on 过滤", () => {
  it("off：schema 无 includeInvalidated，含失效行原文逐字节返回", async () => {
    const { mock } = makeStorage(PREFIX, { "a.md": `A\n${MARK} B\nC` });
    const { read } = createStorageTools(mock, PREFIX, undefined, "t", 0, false);
    expect(JSON.stringify(read.inputSchema)).not.toContain("includeInvalidated");
    const out = await (read.execute as (a: { path: string }) => Promise<string>)({ path: "a.md" });
    expect(out).toBe(`A\n${MARK} B\nC`);
  });

  it("on：schema 含 includeInvalidated，默认过滤失效行（体积不涨）", async () => {
    const { mock } = makeStorage(PREFIX, { "a.md": `A\n${MARK} B m_1787881381525_2eee472e\nC` });
    const { read } = createStorageTools(mock, PREFIX, undefined, "t", 0, true);
    expect(JSON.stringify(read.inputSchema)).toContain("includeInvalidated");
    const out = await (read.execute as (a: { path: string }) => Promise<string>)({ path: "a.md" });
    expect(out).toBe("A\nC");
    expect(out.length).toBeLessThan(`A\n${MARK} B m_1787881381525_2eee472e\nC`.length);
  });

  it("on：includeInvalidated:true → 全量逐字（审计面=基线 read）", async () => {
    const raw = `A\n${MARK} B\nC`;
    const { mock } = makeStorage(PREFIX, { "a.md": raw });
    const { read } = createStorageTools(mock, PREFIX, undefined, "t", 0, true);
    const out = await (read.execute as (a: { path: string; includeInvalidated?: boolean }) => Promise<string>)({ path: "a.md", includeInvalidated: true });
    expect(out).toBe(raw);
  });

  it("on：窗口切片 + 过滤组合（窗口内的完整失效行被滤、截断标注保留）", async () => {
    // offset=2 落在行中：切片首行 = 空串 + 完整失效行前缀 → 该行被滤，截断标注行保留
    const raw = `AB\n[SUPERSEDED 2026-10-31T10:00:00.000Z] B\nC`;
    const { mock } = makeStorage(PREFIX, { "a.md": raw });
    const { read } = createStorageTools(mock, PREFIX, undefined, "t", 0, true);
    const out = await (read.execute as (a: { path: string; offset?: number; limit?: number }) => Promise<string>)({ path: "a.md", offset: 2, limit: 30 });
    expect(out).not.toContain("SUPERSEDED");
    expect(out).toContain("[... omitted");
  });

  it("on：纯标记行文件默认 read → 空串", async () => {
    const { mock } = makeStorage(PREFIX, { "a.md": `${MARK} a\n[SUPERSEDED] b` });
    const { read } = createStorageTools(mock, PREFIX, undefined, "t", 0, true);
    const out = await (read.execute as (a: { path: string }) => Promise<string>)({ path: "a.md" });
    expect(out).toBe("");
  });
});

describe("storage-tools write/edit：off 钉 / on 锚点守卫", () => {
  it("off：edit 删锚点行照常成功（无守卫，基线行为）", async () => {
    const { mock, store } = makeStorage(PREFIX, { "a.md": SCENE_A });
    const { edit } = createStorageTools(mock, PREFIX, undefined, "t", 0, false);
    const out = await (edit.execute as (a: unknown) => Promise<string>)({
      path: "a.md",
      edits: [{ oldText: "- 旧事实 m_1787881381525_2eee472e\n", newText: "" }],
    });
    expect(parseOut(out).success).toBe(true);
    expect(store.get(`${PREFIX}a.md`)).toBe("## 叙事\n尾行");
  });

  it("off：cap 拒绝体恰为方案C 五键（无 superseded 附加键）", async () => {
    const { mock } = makeStorage(PREFIX, {});
    const { write } = createStorageTools(mock, PREFIX, undefined, "t", 100, false);
    const out = await (write.execute as (a: { path: string; content: string }) => Promise<string>)({ path: "n.md", content: "x".repeat(150) });
    expect(Object.keys(parseOut(out)).sort()).toEqual(["cap", "chars", "error", "hint", "overflow"]);
  });

  it("on：edit 丢锚 → anchor_loss_forbidden 且原文件字节不变", async () => {
    const { mock, store } = makeStorage(PREFIX, { "a.md": SCENE_A });
    const { edit } = createStorageTools(mock, PREFIX, undefined, "t", 0, true);
    const out = await (edit.execute as (a: unknown) => Promise<string>)({
      path: "a.md",
      edits: [{ oldText: "- 旧事实 m_1787881381525_2eee472e\n", newText: "" }],
    });
    const r = parseOut(out);
    expect(r.error).toBe("anchor_loss_forbidden");
    expect(r.lostCount).toBe(1);
    expect(store.get(`${PREFIX}a.md`)).toBe(SCENE_A);
  });

  it("on：加 [SUPERSEDED] 前缀保留锚点 → 放行落盘", async () => {
    const { mock, store } = makeStorage(PREFIX, { "a.md": SCENE_A });
    const { edit } = createStorageTools(mock, PREFIX, undefined, "t", 0, true);
    const out = await (edit.execute as (a: unknown) => Promise<string>)({
      path: "a.md",
      edits: [{ oldText: "- 旧事实 m_1787881381525_2eee472e", newText: `${MARK} - 旧事实 m_1787881381525_2eee472e` }],
    });
    expect(parseOut(out).success).toBe(true);
    expect(store.get(`${PREFIX}a.md`)).toBe(`## 叙事\n${MARK} - 旧事实 m_1787881381525_2eee472e\n尾行`);
  });

  it("on：write 整体重写丢锚 → 拒绝且不落盘（新文件不受限）", async () => {
    const { mock, store } = makeStorage(PREFIX, { "a.md": SCENE_A });
    const { write } = createStorageTools(mock, PREFIX, undefined, "t", 0, true);
    const out = await (write.execute as (a: { path: string; content: string }) => Promise<string>)({ path: "a.md", content: "全新内容无锚" });
    expect(parseOut(out).error).toBe("anchor_loss_forbidden");
    expect(store.get(`${PREFIX}a.md`)).toBe(SCENE_A);
    const out2 = await (write.execute as (a: { path: string; content: string }) => Promise<string>)({ path: "new.md", content: "新建无约束" });
    expect(parseOut(out2).success).toBe(true);
  });

  it("on：畸形输入——前像无锚（纯叙事）edit/write 均放行", async () => {
    const { mock } = makeStorage(PREFIX, { "a.md": "纯叙事无锚点" });
    const { write } = createStorageTools(mock, PREFIX, undefined, "t", 0, true);
    const out = await (write.execute as (a: { path: string; content: string }) => Promise<string>)({ path: "a.md", content: "重写叙事" });
    expect(parseOut(out).success).toBe(true);
  });
});

describe("storage-tools [DELETED] 软删流：文件级重定位守卫", () => {
  it("on：锚点未迁移 → 拒绝且文件保持原内容（不落 [DELETED]）", async () => {
    const { mock, store } = makeStorage(PREFIX, { "a.md": SCENE_A, "b.md": "无关场景" });
    const { write } = createStorageTools(mock, PREFIX, undefined, "t", 0, true);
    const out = await (write.execute as (a: { path: string; content: string }) => Promise<string>)({ path: "a.md", content: "[DELETED]" });
    const r = parseOut(out);
    expect(r.error).toBe("anchor_loss_forbidden");
    expect(String(r.hint)).toContain("[DELETED]");
    expect(store.get(`${PREFIX}a.md`)).toBe(SCENE_A);
  });

  it("on：锚点已迁入合并目标 → 放行（MERGE 收尾可用）", async () => {
    const { mock, store } = makeStorage(PREFIX, {
      "a.md": SCENE_A,
      "merged.md": `合并目标\n${MARK} - 旧事实 m_1787881381525_2eee472e`,
    });
    const { write } = createStorageTools(mock, PREFIX, undefined, "t", 0, true);
    const out = await (write.execute as (a: { path: string; content: string }) => Promise<string>)({ path: "a.md", content: "[DELETED]" });
    expect(parseOut(out).success).toBe(true);
    expect(store.get(`${PREFIX}a.md`)).toBe("[DELETED]");
  });

  it("on：前像无锚（纯叙事文件）→ [DELETED] 放行；新建文件写 [DELETED] 放行", async () => {
    const { mock } = makeStorage(PREFIX, { "a.md": "纯叙事" });
    const { write } = createStorageTools(mock, PREFIX, undefined, "t", 0, true);
    expect(parseOut(await (write.execute as (a: { path: string; content: string }) => Promise<string>)({ path: "a.md", content: "[DELETED]" })).success).toBe(true);
    expect(parseOut(await (write.execute as (a: { path: string; content: string }) => Promise<string>)({ path: "ghost.md", content: "[DELETED]" })).success).toBe(true);
  });
});

describe("storage-tools metric=l2_supersede 与失效帽排除口径", () => {
  it("on：edit 引入 2 失效行 → metric 行 value=2；off → 零 metric 行", async () => {
    const base = "## 叙事\n- 旧1 m_1787881381525_2eee472e\n- 旧2 m_1788449899823_245dfba6\n";
    const { mock } = makeStorage(PREFIX, { "a.md": base });
    const logger = makeLogger();
    const { edit } = createStorageTools(mock, PREFIX, logger, "t", 0, true);
    await (edit.execute as (a: unknown) => Promise<string>)({
      path: "a.md",
      edits: [
        { oldText: "- 旧1 m_1787881381525_2eee472e", newText: `${MARK} - 旧1 m_1787881381525_2eee472e` },
        { oldText: "- 旧2 m_1788449899823_245dfba6", newText: `${MARK} - 旧2 m_1788449899823_245dfba6` },
      ],
    });
    expect(logger.infos.filter((m) => m.includes("metric=l2_supersede value=2")).length).toBe(1);
    expect(logger.infos.some((m) => m.includes("path=a.md"))).toBe(true);

    const { mock: mock2 } = makeStorage(PREFIX, { "a.md": base });
    const logger2 = makeLogger();
    const { edit: edit2 } = createStorageTools(mock2, PREFIX, logger2, "t", 0, false);
    await (edit2.execute as (a: unknown) => Promise<string>)({
      path: "a.md",
      edits: [{ oldText: "- 旧1 m_1787881381525_2eee472e", newText: `${MARK} - 旧1 m_1787881381525_2eee472e` }],
    });
    expect(logger2.infos.some((m) => m.includes("metric="))).toBe(false);
  });

  it("on：失效行多活内容小 → 排除口径放行；活超帽 → 拒绝体带 superseded 键", async () => {
    const dead = Array.from({ length: 50 }, (_, i) => `${MARK} 旧事实${i}`).join("\n");
    const { mock } = makeStorage(PREFIX, {});
    const { write } = createStorageTools(mock, PREFIX, undefined, "t", 100, true);
    const ok = await (write.execute as (a: { path: string; content: string }) => Promise<string>)({ path: "a.md", content: `${dead}\nlive` });
    expect(parseOut(ok).success).toBe(true);

    const { mock: mock2 } = makeStorage(PREFIX, {});
    const { write: write2 } = createStorageTools(mock2, PREFIX, undefined, "t", 100, true);
    const rejected = await (write2.execute as (a: { path: string; content: string }) => Promise<string>)({ path: "b.md", content: `${dead}\n${"y".repeat(150)}` });
    const r = parseOut(rejected);
    expect(r.error).toBe("over_scene_char_cap");
    expect(r.chars).toBe(150);
    expect(r.supersededLines).toBe(50);
    expect((r.supersededChars as number).valueOf()).toBeGreaterThan(0);
  });

  it("L3 豁免：prefix 为空时 on 也不启用守卫（persona 不受限）", async () => {
    const { mock, store } = makeStorage("", { "persona.md": "锚 m_1787881381525_2eee472e" });
    const { write } = createStorageTools(mock, "", undefined, "t", 100, true);
    const out = await (write.execute as (a: { path: string; content: string }) => Promise<string>)({ path: "persona.md", content: "重写无锚" });
    expect(parseOut(out).success).toBe(true);
    expect(store.get("persona.md")).toBe("重写无锚");
  });
});
