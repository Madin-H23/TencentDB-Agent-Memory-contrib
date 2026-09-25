// Knowledge 服务键门（回移上游 #1385，2026-09-25）
//
// 关键语义——**默认关闭**：`KNOWLEDGE_SERVICE_KEY` 未设置时全部放行，
// 与上游「向后兼容本地/开发部署」一致；只有显式设置后，写/管理面才 fail-closed。
// 本地部署实测：`entity_knowledge` 表 0 行、面板与 hook 均未调用 /v3/knowledge，
// 因此未设置该变量时行为与改动前完全一致（零影响回移）。
import { describe, expect, it } from "vitest";
import { verifyKnowledgeBearer, KNOWLEDGE_READ_ONLY_PATHS } from "./knowledge-handlers.js";

describe("verifyKnowledgeBearer", () => {
  const KEY = "sk-knowledge-service-123";

  it("正确 Bearer 通过", () => {
    expect(verifyKnowledgeBearer(`Bearer ${KEY}`, KEY)).toBe(true);
  });

  it("大小写与词间空白容错，但 `Bearer` 前有空白仍拒绝（与上游正则一致）", () => {
    expect(verifyKnowledgeBearer(`bearer ${KEY}`, KEY)).toBe(true);
    expect(verifyKnowledgeBearer(`Bearer   ${KEY}  `, KEY)).toBe(true);
    // 上游 #1385 的正则是 /^Bearer\s+(\S+)\s*$/i，不接受前导空白；
    // 回移保持与上游一致（HTTP 头解析本身会剥掉 OWS），不擅自放宽。
    expect(verifyKnowledgeBearer(`  Bearer ${KEY}`, KEY)).toBe(false);
  });

  it("缺失 / 格式错 / key 不符 一律拒绝（fail-closed）", () => {
    expect(verifyKnowledgeBearer(undefined, KEY)).toBe(false);
    expect(verifyKnowledgeBearer("", KEY)).toBe(false);
    expect(verifyKnowledgeBearer("Basic abc", KEY)).toBe(false);
    expect(verifyKnowledgeBearer(`Bearer `, KEY)).toBe(false);
    expect(verifyKnowledgeBearer(`Bearer ${KEY}x`, KEY)).toBe(false);
    expect(verifyKnowledgeBearer(`Bearer ${KEY.slice(0, -1)}`, KEY)).toBe(false);
  });

  it("空 serviceKey 时不启用鉴权（上游兼容语义，由调用方短路）", () => {
    // 空 key 不应在这里被当成「万能钥匙」——调用方先判空再决定是否校验。
    expect(verifyKnowledgeBearer("Bearer anything", "")).toBe(false);
  });
});

describe("只读白名单", () => {
  it("get/list 保持开放，create/update/delete 需服务键", () => {
    expect(KNOWLEDGE_READ_ONLY_PATHS.has("/v3/knowledge/get")).toBe(true);
    expect(KNOWLEDGE_READ_ONLY_PATHS.has("/v3/knowledge/list")).toBe(true);
    for (const p of ["/v3/knowledge/create", "/v3/knowledge/update", "/v3/knowledge/delete"]) {
      expect(KNOWLEDGE_READ_ONLY_PATHS.has(p), `${p} 不应进只读白名单`).toBe(false);
    }
  });
});
