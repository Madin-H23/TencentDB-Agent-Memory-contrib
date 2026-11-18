// 票 origin#36 第四分票（QA·auto-recall 召回参数与过滤链）：隔离作用域纯函数层直测。
// performAutoRecallCore（auto-recall.ts:166-175）用 buildProfileIsolationScope 解析
// L2/L3 租户作用域，防跨租户 profile 读取——这是召回过滤链的安全核心。
// 这组纯函数（profile-scope.ts）此前零直接测试（全仓 .test.ts grep 无引用），
// 零 IO、零实现改动，抽直测零风险。契约来自源码+设计文档 D12 ③。
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROFILE_SCOPE,
  buildProfileIsolationScope,
  profileScopeFilter,
  profileRowInScope,
  parseProfileIsolationScope,
  buildProfileStableId,
  type ProfileIsolation,
} from "./profile-scope.js";
import type { ProfileRecord } from "../store/types.js";

function row(over: Partial<Pick<ProfileRecord, "teamId" | "userId" | "agentId">>): Pick<ProfileRecord, "teamId" | "userId" | "agentId"> {
  return { teamId: "", userId: "", agentId: "", ...over };
}

describe("buildProfileIsolationScope：隔离上下文→作用域字符串（origin#36 第四分票）", () => {
  it("undefined → global 缺省作用域（不套前缀=读全局数据根）", () => {
    expect(buildProfileIsolationScope(undefined)).toBe(DEFAULT_PROFILE_SCOPE);
    expect(DEFAULT_PROFILE_SCOPE).toBe("global");
  });

  it("team+agent 双维 → team:<id>|agent:<id>", () => {
    expect(buildProfileIsolationScope({ teamId: "team-A", agentId: "agent-1" })).toBe("team:team-A|agent:agent-1");
  });

  it("teamId 优先，userId 仅在缺 teamId 时兜底（折叠进同一槽）", () => {
    expect(buildProfileIsolationScope({ userId: "user-X", agentId: "agent-1" })).toBe("team:user-X|agent:agent-1");
    // team 与 user 同在 → team 胜出（userId 被忽略）
    expect(buildProfileIsolationScope({ teamId: "team-A", userId: "user-X", agentId: "agent-1" })).toBe("team:team-A|agent:agent-1");
    // 空 teamId（falsy）→ userId 兜底
    expect(buildProfileIsolationScope({ teamId: "", userId: "user-X", agentId: "agent-1" })).toBe("team:user-X|agent:agent-1");
  });

  it("缺 agentId → 缺省 default；sessionId 被刻意忽略（L2/L3 团队级记忆跨会话累积）", () => {
    expect(buildProfileIsolationScope({ teamId: "team-A" })).toBe("team:team-A|agent:default");
    expect(buildProfileIsolationScope({ teamId: "team-A", sessionId: "sess-1" })).toBe("team:team-A|agent:default");
    expect(buildProfileIsolationScope({})).toBe("team:default|agent:default");
  });
});

describe("profileScopeFilter：隔离上下文→行查询条件（D12 ③ 同集不变量）", () => {
  it("undefined → 空过滤（不约束任何维度=全局）", () => {
    expect(profileScopeFilter(undefined)).toEqual({});
  });

  it("有 teamId → 只约束 team+agent，绝不约束 userId（否则 list 比 lookup 窄）", () => {
    const f = profileScopeFilter({ teamId: "team-A", userId: "user-X", agentId: "agent-1" });
    expect(f).toEqual({ teamId: "team-A", agentId: "agent-1" });
    expect(f.userId).toBeUndefined();
  });

  it("缺 teamId → team 钉空串 + userId 约束（有值或空串）", () => {
    expect(profileScopeFilter({ userId: "user-X", agentId: "agent-1" })).toEqual({
      teamId: "",
      userId: "user-X",
      agentId: "agent-1",
    });
    // 无 team 也无 user → team/user 都钉空串（"无"是值不是跳过）
    expect(profileScopeFilter({})).toEqual({ teamId: "", userId: "", agentId: "" });
  });

  it("extra 条件被合并保留（type/pathPrefix 等）", () => {
    expect(profileScopeFilter({ teamId: "t", agentId: "a" }, { type: "l2", pathPrefix: "scene" })).toEqual({
      teamId: "t",
      agentId: "a",
      type: "l2",
      pathPrefix: "scene",
    });
  });
});

describe("profileRowInScope：行是否落在作用域内（按 id 取行后的补门）", () => {
  it("team+agent 匹配 → true；agent 不符 → false", () => {
    const iso: ProfileIsolation = { teamId: "team-A", agentId: "agent-1" };
    expect(profileRowInScope(row({ teamId: "team-A", agentId: "agent-1" }), iso)).toBe(true);
    expect(profileRowInScope(row({ teamId: "team-A", agentId: "agent-2" }), iso)).toBe(false);
    expect(profileRowInScope(row({ teamId: "team-B", agentId: "agent-1" }), iso)).toBe(false);
  });

  it("team/user 折叠坑：{teamId:x} 与 {userId:x} 作用域不同，行不能串味", () => {
    const teamIso: ProfileIsolation = { teamId: "X", agentId: "a" };
    const userIso: ProfileIsolation = { userId: "X", agentId: "a" };
    const teamRow = row({ teamId: "X", agentId: "a" }); // 新写入行 team=X,user 空
    const userRow = row({ userId: "X", agentId: "a" }); // 旧行 team 空,user=X
    expect(profileRowInScope(teamRow, teamIso)).toBe(true);
    expect(profileRowInScope(teamRow, userIso)).toBe(false); // team 行不被 user 作用域捞走
    expect(profileRowInScope(userRow, userIso)).toBe(true);
    expect(profileRowInScope(userRow, teamIso)).toBe(false);
  });

  it("undefined isolation → 无约束，任何行都算在内（全局视图）", () => {
    expect(profileRowInScope(row({ teamId: "any", agentId: "any" }), undefined)).toBe(true);
  });

  it("缺字段（undefined）按空串比对", () => {
    expect(profileRowInScope(row({ teamId: undefined, agentId: undefined }), { agentId: "" })).toBe(true);
  });
});

describe("parseProfileIsolationScope：作用域字符串反解（往返）", () => {
  it("team+agent 往返一致", () => {
    const iso = { teamId: "team-A", agentId: "agent-1" };
    expect(parseProfileIsolationScope(buildProfileIsolationScope(iso))).toEqual(iso);
  });

  it("userId 兜底折叠单向不可逆：{userId:x} → team:x 槽，反解得 {teamId:x}（设计边界钉住）", () => {
    const iso = { userId: "user-X", agentId: "agent-1" };
    const scope = buildProfileIsolationScope(iso);
    expect(scope).toBe("team:user-X|agent:agent-1"); // user 被折叠进 team 槽
    // 折叠后与真实 team 同型 → 反解只能还原为 teamId，无法区分原本是 user（单向不可逆）
    expect(parseProfileIsolationScope(scope)).toEqual({ teamId: "user-X", agentId: "agent-1" });
  });

  it("带 sessionId 的作用域可反解（session 透传字段）", () => {
    expect(parseProfileIsolationScope("team:t|agent:a|session:s1")).toEqual({
      teamId: "t",
      agentId: "a",
      sessionId: "s1",
    });
    // URL 编码的 session 被安全解码
    expect(parseProfileIsolationScope("team:t|agent:a|session:s%201")).toEqual({
      teamId: "t",
      agentId: "a",
      sessionId: "s 1",
    });
  });

  it("畸形Scope → undefined（fail-closed）", () => {
    expect(parseProfileIsolationScope("global")).toBeUndefined(); // 无 agent 段
    expect(parseProfileIsolationScope("team:t")).toBeUndefined();
    expect(parseProfileIsolationScope("badformat")).toBeUndefined();
    expect(parseProfileIsolationScope("|agent:a")).toBeUndefined(); // 空键
  });

  it("既无 team 也无 user 的合法 agent 段 → undefined（无法构造 isolation）", () => {
    expect(parseProfileIsolationScope("agent:a")).toBeUndefined();
  });
});

describe("buildProfileStableId：作用域+类型+文件名的确定性行 id", () => {
  it("同三元组两次 → 同一 id（确定性 upsert 不插重复行）", () => {
    const a = buildProfileStableId("team:t|agent:a", "l2", "scene.md");
    const b = buildProfileStableId("team:t|agent:a", "l2", "scene.md");
    expect(a).toBe(b);
    expect(a).toMatch(/^profile:v1:/);
  });

  it("任一维不同 → id 不同（作用域/类型/文件名区分）", () => {
    const base = buildProfileStableId("team:t|agent:a", "l2", "scene.md");
    expect(buildProfileStableId("team:t|agent:b", "l2", "scene.md")).not.toBe(base);
    expect(buildProfileStableId("team:t|agent:a", "l3", "scene.md")).not.toBe(base);
    expect(buildProfileStableId("team:t|agent:a", "l2", "other.md")).not.toBe(base);
  });

  it("NUL 分隔防三元组边界串味——分隔符改成 | 会碰撞（审查 P2 变异敏感断言）", () => {
    const nul = String.fromCharCode(0);
    const c1 = buildProfileStableId("a" + nul + "b", "l2", "c");
    const c2 = buildProfileStableId("a", "l2", "b" + nul + "c");
    expect(c1).not.toBe(c2);
    // 关键：scope 本身含 '|'（本仓 team:t|agent:a 是常见形态）。若分隔符误用 '|'，
    // 下面两组三元组会哈希成同一字符串 → 真碰撞。此断言对「分隔符≠NUL」变异敏感，
    // 补上审查指出的缺口（旧 c1/c2 用例在 | 分隔下仍绿=弱断言）。
    expect(buildProfileStableId("x|l2", "l2", "z")).not.toBe(buildProfileStableId("x", "l2", "l2|z"));
  });
});
