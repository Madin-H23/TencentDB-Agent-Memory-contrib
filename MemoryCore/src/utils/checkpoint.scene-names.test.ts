// checkpoint per-sid 场景连续性（L0 多线程串线治理，2026-10-09 拍板选项1）：
// 多个 ZCode 会话共用一个 sessionKey 后，last_scene_name 单键会被最后蒸馏的
// 线程占据——【上一个情境】hint 跨线程互串。方案：RunnerSessionState 增加
// last_scene_names（per-sessionId 映射），旧单键保留作回退与向后兼容。
// 红线：绝不能动 runner_states 的键格式（tdai-core/面板/acceptance 三处按
// runner_states[sessionKey].last_l1_cursor 读游标，键一改=全量重蒸馏）。
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CheckpointManager, type Checkpoint } from "./checkpoint.js";

let dir: string;
const newMgr = () => new CheckpointManager((dir = mkdtempSync(join(tmpdir(), "ckpt-sid-test-"))));
const cleanup = () => rmSync(dir, { recursive: true, force: true });

const ckptFile = () => join(dir, ".metadata", "recall_checkpoint.json");

async function readCp(): Promise<Checkpoint> {
  return JSON.parse(readFileSync(ckptFile(), "utf-8")) as Checkpoint;
}

describe("markL1ExtractionComplete：per-sid 场景名写入与合并", () => {
  it("lastSceneNames 落到 runner_states[key].last_scene_names，旧单键同步保留", async () => {
    const mgr = newMgr();
    try {
      await mgr.markL1ExtractionComplete("zcode-default", 2, 1000, "场景A", { "sess-A": "场景A" });
      const cp = await readCp();
      const st = cp.runner_states!["zcode-default"];
      expect(st.last_scene_names).toEqual({ "sess-A": "场景A" });
      expect(st.last_scene_name).toBe("场景A"); // 向后兼容：旧读者仍能拿到最后场景
      expect(st.last_l1_cursor).toBe(1000);
    } finally {
      cleanup();
    }
  });

  it("多 sid 跨轮合并而非覆盖（A 轮写 A，B 轮写 B，两者并存）", async () => {
    const mgr = newMgr();
    try {
      await mgr.markL1ExtractionComplete("zcode-default", 1, 1000, "场景A", { "sess-A": "场景A" });
      await mgr.markL1ExtractionComplete("zcode-default", 1, 2000, "场景B", { "sess-B": "场景B" });
      const cp = await readCp();
      const st = cp.runner_states!["zcode-default"];
      expect(st.last_scene_names).toEqual({ "sess-A": "场景A", "sess-B": "场景B" });
      expect(st.last_scene_name).toBe("场景B"); // 单键语义不变：最后一轮的场景
      expect(st.last_l1_cursor).toBe(2000);
    } finally {
      cleanup();
    }
  });

  it("同 sid 跨轮更新取最新值", async () => {
    const mgr = newMgr();
    try {
      await mgr.markL1ExtractionComplete("zcode-default", 1, 1000, "场景A1", { "sess-A": "场景A1" });
      await mgr.markL1ExtractionComplete("zcode-default", 1, 2000, "场景A2", { "sess-A": "场景A2" });
      const cp = await readCp();
      expect(cp.runner_states!["zcode-default"].last_scene_names).toEqual({ "sess-A": "场景A2" });
    } finally {
      cleanup();
    }
  });

  it("不传 lastSceneNames 的旧式调用：不产生该字段（存量行为零变化）", async () => {
    const mgr = newMgr();
    try {
      await mgr.markL1ExtractionComplete("zcode-default", 0, 500, "旧场景");
      const cp = await readCp();
      const st = cp.runner_states!["zcode-default"];
      expect(st.last_scene_name).toBe("旧场景");
      expect(st.last_scene_names).toBeUndefined();
    } finally {
      cleanup();
    }
  });
});

describe("旧 checkpoint 兼容与引用安全", () => {
  it("存量文件（无 last_scene_names 字段）：读不崩、字段缺省、写新字段不破坏旧字段", async () => {
    const mgr = newMgr();
    try {
      // 模拟改造前的 checkpoint 形状
      const metaDir = join(dir, ".metadata");
      mkdirSync(metaDir, { recursive: true });
      writeFileSync(
        ckptFile(),
        JSON.stringify({
          last_captured_timestamp: 0,
          total_processed: 3,
          runner_states: {
            "zcode-default": { last_captured_timestamp: 42, last_l1_cursor: 41, last_scene_name: "历史场景" },
          },
          pipeline_states: {},
        }),
        "utf-8",
      );
      await mgr.markL1ExtractionComplete("zcode-default", 1, 900, "新场景", { "sess-A": "新场景" });
      const cp = await readCp();
      const st = cp.runner_states!["zcode-default"];
      expect(st.last_l1_cursor).toBe(900); // 游标推进不受影响
      expect(st.last_scene_names).toEqual({ "sess-A": "新场景" });
      expect(existsSync(ckptFile())).toBe(true);
      void metaDir;
    } finally {
      cleanup();
    }
  });

  it("不同 sessionKey 的 last_scene_names 互不共享引用（defaults-merge 防共享 map）", async () => {
    const mgr = newMgr();
    try {
      await mgr.markL1ExtractionComplete("key-one", 1, 100, "场景1", { "sess-X": "场景1" });
      await mgr.markL1ExtractionComplete("key-two", 1, 200, "场景2", { "sess-Y": "场景2" });
      const cp = await readCp();
      expect(cp.runner_states!["key-one"].last_scene_names).toEqual({ "sess-X": "场景1" });
      expect(cp.runner_states!["key-two"].last_scene_names).toEqual({ "sess-Y": "场景2" });
      // key-three 从未写过场景：不得凭空出现共享的空对象
      await mgr.markL1ExtractionComplete("key-three", 0, 300);
      const cp2 = await readCp();
      expect(cp2.runner_states!["key-three"].last_scene_names).toBeUndefined();
    } finally {
      cleanup();
    }
  });
});
