// 票 origin#33（S1·gateway /v2|/v3 conversation/add 直写路径凭据掩码）：
// origin#28 之③只接了 hook 链（auto-capture→l0-recorder）；v2-router 直写
// 路径（L0 落库+standalone JSONL mirror）同缺陷类暴露面（PR#6 审查 P1 实证）。
// 验收：on→落库内容掩净（向量+JSONL 双面）；off 缺省→逐字节不变（回归钉）；
// shadow→原文不变+metric 计量在 gateway 路径同样生效。
import { describe, it, expect, vi } from "vitest";

import { handleConversationAdd } from "./v2-router.js";
import type { V2RouterDeps } from "./v2-router.js";
import type { IMemoryStore, L0Record } from "../core/store/types.js";
import { createCredentialMasker } from "../utils/credential-mask.js";

const AUTH = { apiKey: "test-key", serviceId: "default" };
const KEY = "sk-abcdefghij0123456789"; // 测试 fixture 假凭据（过 commit 侧凭据闸的形态）

function makeStore() {
  // 不提供 insertL0Batch → 强制走 per-record upsertL0 分支（sqlite/tcvdb 路径）
  return {
    upsertL0: vi.fn(async () => true),
  } as unknown as IMemoryStore & { upsertL0: ReturnType<typeof vi.fn> };
}

function makeDeps(store: IMemoryStore, overrides: Partial<V2RouterDeps> = {}): V2RouterDeps {
  return {
    deployMode: "standalone",
    getStore: () => store,
    getEmbedding: () => undefined,
    getStorage: () => undefined,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    ...overrides,
  } as unknown as V2RouterDeps;
}

function bodyWithKey() {
  return {
    session_id: "sess-mask",
    messages: [
      { role: "user", content: `我的配置 key 是 ${KEY} 请查收`, timestamp: "2026-11-14T09:00:00.000Z" },
      { role: "assistant", content: "普通回复不含凭据", timestamp: "2026-11-14T09:00:01.000Z" },
    ],
  };
}

async function capturedRecords(deps: V2RouterDeps, store: ReturnType<typeof makeStore>): Promise<L0Record[]> {
  await handleConversationAdd(bodyWithKey(), AUTH, "req-mask", deps);
  const calls = store.upsertL0.mock.calls as Array<[L0Record, Float32Array | undefined]>;
  return calls.map((c) => c[0]);
}

describe("handleConversationAdd：写入侧凭据掩码（origin#33）", () => {
  it("on：L0 落库内容掩净（保留前缀形态）·off 路径零接线（回归钉）", async () => {
    const store = makeStore();
    const masker = createCredentialMasker({ mode: "on", prefixes: [] });
    const records = await capturedRecords(makeDeps(store, { credentialMasker: masker }), store);
    expect(records).toHaveLength(2);
    expect(records[0].messageText).not.toContain(KEY);
    expect(records[0].messageText).toContain("sk-***masked***");
    expect(records[1].messageText).toBe("普通回复不含凭据"); // 无凭据消息不受影响
  });

  it("off/缺省（credentialMasker 不注入）：messageText 原文逐字节不变（回归钉）", async () => {
    const store = makeStore();
    const records = await capturedRecords(makeDeps(store), store);
    expect(records[0].messageText).toBe(`我的配置 key 是 ${KEY} 请查收`);
  });

  it("shadow：落库原文不变+metric 计量行（gateway 路径同样生效）", async () => {
    const store = makeStore();
    const lines: string[] = [];
    const logger = { info: (m: string) => lines.push(m), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const masker = createCredentialMasker({ mode: "shadow", prefixes: [] }, logger as never);
    const records = await capturedRecords(makeDeps(store, { logger: logger as never, credentialMasker: masker }), store);
    expect(records[0].messageText).toBe(`我的配置 key 是 ${KEY} 请查收`); // shadow 不改文
    expect(lines.some((l) => l.includes("metric=capture_credential_mask_shadow"))).toBe(true);
  });

  it("standalone JSONL mirror 同净（appendFile 行不含明文·含掩码形态）", async () => {
    const store = makeStore();
    const appendFile = vi.fn(async () => {});
    const masker = createCredentialMasker({ mode: "on", prefixes: [] });
    await handleConversationAdd(
      bodyWithKey(),
      AUTH,
      "req-mask",
      makeDeps(store, { getStorage: () => ({ appendFile }) as never, credentialMasker: masker }),
    );
    expect(appendFile).toHaveBeenCalled();
    const allArgs = appendFile.mock.calls.map((c) => String(c[1])).join("\n");
    expect(allArgs).not.toContain(KEY);
    expect(allArgs).toContain("sk-***masked***");
  });

  it("insertL0Batch 路径（keyword-only store·无 embedding）同样掩净", async () => {
    const store = makeStore();
    const masker = createCredentialMasker({ mode: "on", prefixes: [] });
    await handleConversationAdd(bodyWithKey(), AUTH, "req-mask", makeDeps(store, { credentialMasker: masker, getEmbedding: () => undefined }));
    // store 无 insertL0Batch 字段时才回退 upsertL0——这里显式提供 batch 路径
    const batchStore = {
      insertL0Batch: vi.fn(async () => 1),
      upsertL0: vi.fn(async () => true),
    };
    await handleConversationAdd(
      bodyWithKey(),
      AUTH,
      "req-mask",
      makeDeps(batchStore as never, { credentialMasker: masker }),
    );
    const calls = batchStore.insertL0Batch.mock.calls as Array<[L0Record[]]>;
    expect(calls.length).toBeGreaterThan(0);
    for (const rec of calls[0][0]) expect(rec.messageText).not.toContain(KEY);
    expect(calls[0][0][0].messageText).toContain("sk-***masked***");
  });
});
