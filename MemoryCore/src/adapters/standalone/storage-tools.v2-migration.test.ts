// 票⑨（exp/p1-9-scene-v2-migration）：storage 工具层惰性迁移接线。
// 顺序钉：应用模型 edits → 锚点守卫 → toV2Format → 帽检查 → 落盘。
// 覆盖：on 写入即 v2（锚点 lost=0 / summary 同步 / metric）、off 逐字节基线、
// edit 用迁移前 oldText 命中、锚点守卫仍拒绝、[DELETED] 不转换、无 META 不转换、
// 帽按迁移后字节、L3 豁免、迁移后 read 两层视图联动、二次编辑幂等。
import { describe, expect, it } from "vitest";
import type { StorageAdapter } from "../../core/storage/adapter.js";
import { ANCHOR_RE } from "../../utils/supersede.js";
import { toV2Format } from "../../core/scene/scene-format-v2.js";
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

const V1_BATCH = [
  "-----META-START-----",
  "created: 2026-08-28T01:44:31.671Z",
  "updated: 2026-10-29T09:18:10.943Z",
  "summary: 用户在维护记忆系统，当前聚焦 v2 迁移与帽压力治理。",
  "heat: 244",
  "-----META-END-----",
  "",
  "## ★10-29 09:18Z 本批 —— 运行更新",
  "",
  "- **★实跑闭环（记忆ID: m_1793265391167_4a35e058）**：完成日报生成。",
  "- **★同源重投复验（零新增）**：15 条旧记忆同源复验。",
  "- 过程叙事：先检查然后执行。",
  "",
  "## ★10-28 02:36Z 本批 —— 另一批",
  "",
  "### 子段落",
  "- 旧事实 m_1793153662241_0c722b76 仍在。",
].join("\n");

function anchors(s: string): string[] {
  return s.match(ANCHOR_RE) ?? [];
}

describe("storage-tools v2 惰性迁移：write", () => {
  it("on：write v1/批次内容 → 落盘即 v2 三段，锚点多重集不变", async () => {
    const { mock, store } = makeStorage(PREFIX, {});
    const { write } = createStorageTools(mock, PREFIX, undefined, "t", 0, false, true);
    const out = await (write.execute as unknown as Exec)({ path: "a.md", content: V1_BATCH });
    expect(parseOut(out).success).toBe(true);
    const persisted = store.get(`${PREFIX}a.md`)!;
    expect(persisted).toContain("## 要点\n用户在维护记忆系统，当前聚焦 v2 迁移与帽压力治理。");
    expect(persisted).toContain("## 事实");
    expect(persisted).toContain("## 活动");
    expect(persisted).toContain("### ★10-29 09:18Z 本批 —— 运行更新");
    expect(anchors(persisted)).toEqual(anchors(V1_BATCH));
    expect(persisted.slice(0, V1_BATCH.indexOf("-----META-END-----"))).toBe(
      V1_BATCH.slice(0, V1_BATCH.indexOf("-----META-END-----")),
    );
  });

  it("off：write v1 内容逐字节基线（不迁移）", async () => {
    const { mock, store } = makeStorage(PREFIX, {});
    const { write } = createStorageTools(mock, PREFIX, undefined, "t", 0, false, false);
    await (write.execute as unknown as Exec)({ path: "a.md", content: V1_BATCH });
    expect(store.get(`${PREFIX}a.md`)).toBe(V1_BATCH);
  });

  it("on：metric=l2_format_v2 在迁移后打点一次", async () => {
    const { mock } = makeStorage(PREFIX, {});
    const logger = makeLogger();
    const { write } = createStorageTools(mock, PREFIX, logger, "t", 0, false, true);
    await (write.execute as unknown as Exec)({ path: "a.md", content: V1_BATCH });
    expect(logger.infos.filter((m) => m.includes("metric=l2_format_v2 value=1"))).toHaveLength(1);
  });

  it("on：[DELETED] 不转换、不同步、不打 metric", async () => {
    const { mock, store } = makeStorage(PREFIX, { "a.md": V1_BATCH });
    const logger = makeLogger();
    const { write } = createStorageTools(mock, PREFIX, logger, "t", 0, false, true);
    await (write.execute as unknown as Exec)({ path: "a.md", content: "[DELETED]" });
    expect(store.get(`${PREFIX}a.md`)).toBe("[DELETED]");
    expect(logger.infos.some((m) => m.includes("metric=l2_format_v2"))).toBe(false);
  });

  it("on：无 META 的纯叙事文件不转换（保守）", async () => {
    const { mock, store } = makeStorage(PREFIX, {});
    const { write } = createStorageTools(mock, PREFIX, undefined, "t", 0, false, true);
    await (write.execute as unknown as Exec)({ path: "plain.md", content: "纯叙事 m_1787881381525_2eee472e" });
    expect(store.get(`${PREFIX}plain.md`)).toBe("纯叙事 m_1787881381525_2eee472e");
  });

  it("on：已是 v2 内容 → 只做 META.summary 同步（不重排）", async () => {
    const v2 = [
      "-----META-START-----",
      "summary: 旧摘要",
      "-----META-END-----",
      "",
      "## 要点",
      "新要点。",
      "## 事实",
      "- f m_1787881381525_2eee472e",
      "## 活动",
      "叙事",
    ].join("\n");
    const { mock, store } = makeStorage(PREFIX, {});
    const { write } = createStorageTools(mock, PREFIX, undefined, "t", 0, false, true);
    await (write.execute as unknown as Exec)({ path: "v2.md", content: v2 });
    expect(store.get(`${PREFIX}v2.md`)).toBe(v2.replace("summary: 旧摘要", "summary: 新要点。"));
  });

  it("on：帽在迁移之后检查——原始长度放行、迁移后超帽则拒绝且不落盘", async () => {
    const migrated = toV2Format(V1_BATCH);
    expect(migrated.length).toBeGreaterThan(V1_BATCH.length);
    const { mock, store } = makeStorage(PREFIX, {});
    // cap = 原始长度：未迁移内容本可放行，迁移附加段标题后应超帽
    const { write } = createStorageTools(mock, PREFIX, undefined, "t", V1_BATCH.length, false, true);
    const out = await (write.execute as unknown as Exec)({ path: "cap.md", content: V1_BATCH });
    expect(parseOut(out).error).toBe("over_scene_char_cap");
    expect(store.has(`${PREFIX}cap.md`)).toBe(false);

    const ok = createStorageTools(mock, PREFIX, undefined, "t", migrated.length, false, true);
    const out2 = await (ok.write.execute as unknown as Exec)({ path: "cap.md", content: V1_BATCH });
    expect(parseOut(out2).success).toBe(true);
  });

  it("L3 豁免：prefix 为空时 v2 on 也不迁移", async () => {
    const { mock, store } = makeStorage("", {});
    const { write } = createStorageTools(mock, "", undefined, "t", 0, false, true);
    await (write.execute as unknown as Exec)({ path: "persona.md", content: V1_BATCH });
    expect(store.get("persona.md")).toBe(V1_BATCH);
  });
});

describe("storage-tools v2 惰性迁移：edit", () => {
  it("on：edit 用迁移前 oldText 仍命中；落盘为 v2 且替换生效", async () => {
    const { mock, store } = makeStorage(PREFIX, { "a.md": V1_BATCH });
    const { edit } = createStorageTools(mock, PREFIX, undefined, "t", 0, false, true);
    const out = await (edit.execute as unknown as Exec)({
      path: "a.md",
      edits: [{ oldText: "- 过程叙事：先检查然后执行。", newText: "- 过程叙事：先检查、再执行、最后复核。" }],
    });
    expect(parseOut(out).success).toBe(true);
    const persisted = store.get(`${PREFIX}a.md`)!;
    expect(persisted).toContain("- 过程叙事：先检查、再执行、最后复核。");
    expect(persisted).toContain("## 要点");
    expect(persisted).toContain("## 活动");
    expect(anchors(persisted)).toEqual(anchors(V1_BATCH));
  });

  it("on + ⑥ on：edit 删除锚点行 → 守卫拒绝且文件保持原样（仍是 v1）", async () => {
    const { mock, store } = makeStorage(PREFIX, { "a.md": V1_BATCH });
    const { edit } = createStorageTools(mock, PREFIX, undefined, "t", 0, true, true);
    const out = await (edit.execute as unknown as Exec)({
      path: "a.md",
      edits: [{ oldText: "- 旧事实 m_1793153662241_0c722b76 仍在。", newText: "" }],
    });
    expect(parseOut(out).error).toBe("anchor_loss_forbidden");
    expect(store.get(`${PREFIX}a.md`)).toBe(V1_BATCH);
  });

  it("on：迁移后二次 edit 幂等——段标题不重复、无关字节不动", async () => {
    const migrated = toV2Format(V1_BATCH);
    const { mock, store } = makeStorage(PREFIX, { "a.md": migrated });
    const { edit } = createStorageTools(mock, PREFIX, undefined, "t", 0, false, true);
    const out = await (edit.execute as unknown as Exec)({
      path: "a.md",
      edits: [{ oldText: "完成日报生成。", newText: "完成日报生成并复核。" }],
    });
    expect(parseOut(out).success).toBe(true);
    const persisted = store.get(`${PREFIX}a.md`)!;
    expect(persisted).toBe(migrated.replace("完成日报生成。", "完成日报生成并复核。"));
    for (const h of ["## 要点", "## 事实", "## 活动"]) {
      expect(persisted.match(new RegExp(`^${h}[ \\t]*$`, "gm"))).toHaveLength(1);
    }
  });

  it("on：无 META 文件 edit 不迁移", async () => {
    const { mock, store } = makeStorage(PREFIX, { "plain.md": "旧文本 m_1787881381525_2eee472e" });
    const { edit } = createStorageTools(mock, PREFIX, undefined, "t", 0, false, true);
    const out = await (edit.execute as unknown as Exec)({
      path: "plain.md",
      edits: [{ oldText: "旧文本", newText: "新文本" }],
    });
    expect(parseOut(out).success).toBe(true);
    expect(store.get(`${PREFIX}plain.md`)).toBe("新文本 m_1787881381525_2eee472e");
  });
});

describe("storage-tools v2 惰性迁移：read 联动", () => {
  it("迁移落盘后：默认 read 不含活动段，includeArchive 含全部原始叙事与锚点", async () => {
    const { mock } = makeStorage(PREFIX, {});
    const { write, read } = createStorageTools(mock, PREFIX, undefined, "t", 0, false, true);
    await (write.execute as unknown as Exec)({ path: "a.md", content: V1_BATCH });
    const def = await (read.execute as unknown as (a: { path: string }) => Promise<string>)({ path: "a.md" });
    expect(def).toContain("## 要点");
    expect(def).toContain("## 事实");
    expect(def).not.toContain("## 活动");
    expect(def).not.toContain("同源重投复验"); // 活动段叙事折叠
    const full = await (read.execute as unknown as (a: { path: string; includeArchive?: boolean }) => Promise<string>)({
      path: "a.md",
      includeArchive: true,
    });
    expect(full).toContain("## 活动");
    expect(full).toContain("- **★同源重投复验（零新增）**：15 条旧记忆同源复验。");
    expect(anchors(full)).toEqual(anchors(V1_BATCH));
    expect(full.length).toBeLessThanOrEqual(V1_BATCH.length + 200); // 迁移只加段标题/少量换行
  });
});
