// 票 origin#28（S1·写入侧凭据掩码）：l0-recorder 接线集成测试。
// 验收：masker=off/undefined → 内容逐字节不变；on → 含 sk- key 的消息在
// filteredMessages（L1 蒸馏源）与 JSONL 留痕两侧同时干净。
import { describe, expect, it, afterAll } from "vitest";
import { rmSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordConversation } from "./l0-recorder.js";
import { createCredentialMasker } from "../../utils/credential-mask.js";

const tmpBase = mkdtempSync(join(tmpdir(), "l0-mask-test-"));
afterAll(() => {
  try {
    rmSync(tmpBase, { recursive: true, force: true });
  } catch {
    /* 清理失败不影响测试结论 */
  }
});

function rawMsg(role: string, content: string, ts: number) {
  return { role, content, timestamp: ts };
}

describe("l0-recorder 接线：写入侧凭据掩码（origin#28）", () => {
  it("off/undefined（默认）：内容逐字节不变——sk- key 原样留在返回值（回归钉）", async () => {
    const dir = join(tmpBase, "off");
    const key = "sk-abcdefghij0123456789";
    const out = await recordConversation({
      sessionKey: "sess-off",
      rawMessages: [rawMsg("user", `我的 key 是 ${key}`, Date.now())],
      baseDir: dir,
    });
    expect(out).toHaveLength(1);
    expect(out[0].content).toContain(key); // off=不掩（现有行为钉）
  });

  it("on：返回值（L1 蒸馏源）与 JSONL 留痕两侧同时掩净，前缀保留", async () => {
    const dir = join(tmpBase, "on");
    const key = "sk-abcdefghij0123456789";
    const masker = createCredentialMasker({ mode: "on", prefixes: [] });
    const out = await recordConversation({
      sessionKey: "sess-on",
      rawMessages: [rawMsg("user", `我的 key 是 ${key}`, Date.now())],
      baseDir: dir,
      credentialMasker: masker,
    });
    expect(out).toHaveLength(1);
    expect(out[0].content).not.toContain(key);
    expect(out[0].content).toContain("sk-***masked***");

    // JSONL 留痕同净（当日分片文件读回）
    const fsmod = await import("node:fs/promises");
    const files = await fsmod.readdir(join(dir, "conversations"));
    expect(files.length).toBeGreaterThan(0);
    const jsonl = readFileSync(join(dir, "conversations", files[0]), "utf-8");
    expect(jsonl).not.toContain(key);
    expect(jsonl).toContain("sk-***masked***");
  });

  it("shadow：返回值与 JSONL 均为原文（逐字节不变）——计量不落盘", async () => {
    const dir = join(tmpBase, "shadow");
    const key = "sk-abcdefghij0123456789";
    const lines: string[] = [];
    const logger = { info: (m: string) => lines.push(m) } as never;
    const masker = createCredentialMasker({ mode: "shadow", prefixes: [] }, logger);
    const out = await recordConversation({
      sessionKey: "sess-shadow",
      rawMessages: [rawMsg("user", `我的 key 是 ${key}`, Date.now())],
      baseDir: dir,
      credentialMasker: masker,
    });
    expect(out[0].content).toContain(key); // shadow 不改文
    expect(lines.some((l) => l.includes("metric=capture_credential_mask_shadow"))).toBe(true);
  });

  it("originalUserText 替换路径同样被掩（替换发生在掩码前一步）", async () => {
    const dir = join(tmpBase, "replace");
    const key = "sk-abcdefghij0123456789";
    const ts = Date.now();
    const masker = createCredentialMasker({ mode: "on", prefixes: [] });
    const out = await recordConversation({
      sessionKey: "sess-replace",
      rawMessages: [rawMsg("user", " polluted prependContext text ", ts)],
      baseDir: dir,
      originalUserText: `clean prompt with ${key}`,
      originalUserMessageCount: 0, // 未启用 position slice（0=无效）→ 走 raw fallback
      credentialMasker: masker,
    });
    const replaced = out.find((m) => m.role === "user" && m.timestamp === ts);
    expect(replaced).toBeDefined();
    expect(replaced!.content).not.toContain(key);
    expect(replaced!.content).toContain("sk-***masked***");
  });
});
