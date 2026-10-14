// P2（2026-10-14，v2 3eb7c8b 移植）：用户归属确定性归一。规则：出现「用户（X）」——
// X ∈ 自指词 → 归一「用户」；X ∈ 白名单（userIdentityNames）→ 原样保留；
// 其余（第三方姓名/角色标签/路径数字/状语）→ 丢括号归一「用户」并回传 dropped 供审计。
// 背景（v2 2026-09-24 事故）：纯提示词挡不住模型往姓名括号塞垃圾（265 条误归属实测）。
import { describe, it, expect } from "vitest";
import { sanitizeUserAttribution } from "./attribution.js";

describe("sanitizeUserAttribution：白名单归一", () => {
  it("白名单姓名原样保留", () => {
    const r = sanitizeUserAttribution("用户（何伟健）决定了 v3 迁移方案", ["何伟健", "heweijian"]);
    expect(r.text).toBe("用户（何伟健）决定了 v3 迁移方案");
    expect(r.dropped).toEqual([]);
  });

  it("白名单匹配大小写不敏感", () => {
    const r = sanitizeUserAttribution("用户（HeWeijian）签署了协议", ["heweijian"]);
    expect(r.text).toBe("用户（HeWeijian）签署了协议");
  });

  it("自指词归一为「用户」且不入 dropped", () => {
    const r = sanitizeUserAttribution("用户（本人）确认了配置；用户（我）同意");
    expect(r.text).toBe("用户确认了配置；用户同意");
    expect(r.dropped).toEqual([]);
  });

  it("第三方姓名/角色标签/路径数字 → 归一「用户」并回传 dropped（去重保序）", () => {
    const r = sanitizeUserAttribution(
      "用户（王缘林）提交了代码；用户（导师）审阅；路径是 C:\\Users\\28951 下用户（28951）的目录",
      [],
    );
    expect(r.text).toBe("用户提交了代码；用户审阅；路径是 C:\\Users\\28951 下用户的目录");
    expect(r.dropped).toEqual(["王缘林", "导师", "28951"]);
  });

  it("半角括号同样覆盖", () => {
    const r = sanitizeUserAttribution("用户(导师)提了问题", []);
    expect(r.text).toBe("用户提了问题");
    expect(r.dropped).toEqual(["导师"]);
  });

  it("无「用户（X）」句式的文本原样透传", () => {
    const r = sanitizeUserAttribution("用户讨论了部署方案，导师没有参与", ["何伟健"]);
    expect(r.text).toBe("用户讨论了部署方案，导师没有参与");
    expect(r.dropped).toEqual([]);
  });

  it("超长括号内容（>60 字符）不吞（限长保护）", () => {
    const long = "x".repeat(80);
    const text = `用户（${long}）说了话`;
    const r = sanitizeUserAttribution(text, []);
    expect(r.text).toBe(text);
    expect(r.dropped).toEqual([]);
  });

  it("空白名单等价于全部归一（除自指词）", () => {
    const r = sanitizeUserAttribution("用户（张三）与用户（李四）开会", undefined);
    expect(r.text).toBe("用户与用户开会");
    expect(r.dropped).toEqual(["张三", "李四"]);
  });
});
