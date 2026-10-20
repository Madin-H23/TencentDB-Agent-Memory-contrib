// 复合标签匹配（批次 2.1 增补）。
//
// 模型常写「用户（何伟健/heweijian）」这类**同一身份的多写法**。原实现按整串
// 精确匹配，会把用户自己的别名误判成第三方姓名而丢弃（现场实测 7 行）。
// 现按分隔符切分复合标签，要求**每一段都命中白名单**才整串保留。
//
// 覆盖：复合标签保留、含第三方整串丢弃、各种分隔符、大小写、前缀写法、
// 边界（单段/空段/超长）、异常输入。
import { describe, expect, it } from "vitest";
import { sanitizeUserAttribution } from "./attribution.js";

const WL = ["何伟健", "heweijian", "Weijian He", "Madin-H23"];

describe("复合标签：全部命中 → 整串保留", () => {
  it("斜杠分隔的中英文名", () => {
    const r = sanitizeUserAttribution("用户（何伟健/heweijian）联合确认", WL);
    expect(r.text).toBe("用户（何伟健/heweijian）联合确认");
    expect(r.dropped).toEqual([]);
  });

  it("斜杠分隔且顺序颠倒", () => {
    const r = sanitizeUserAttribution("用户（heweijian/何伟健）确认", WL);
    expect(r.text).toBe("用户（heweijian/何伟健）确认");
  });

  it("带前缀的署名命中白名单项（GitHub Madin-H23）", () => {
    const r = sanitizeUserAttribution("用户（Weijian He / GitHub Madin-H23）确认", WL);
    expect(r.text).toBe("用户（Weijian He / GitHub Madin-H23）确认");
    expect(r.dropped).toEqual([]);
  });

  it("顿号分隔", () => {
    const r = sanitizeUserAttribution("用户（何伟健、heweijian）确认", WL);
    expect(r.text).toBe("用户（何伟健、heweijian）确认");
  });

  it("中文逗号分隔", () => {
    const r = sanitizeUserAttribution("用户（何伟健，何伟健）确认", WL);
    expect(r.text).toBe("用户（何伟健，何伟健）确认");
  });

  it("竖线分隔", () => {
    const r = sanitizeUserAttribution("用户（何伟健|heweijian）确认", WL);
    expect(r.text).toBe("用户（何伟健|heweijian）确认");
  });

  it("& 分隔", () => {
    const r = sanitizeUserAttribution("用户（何伟健&heweijian）确认", WL);
    expect(r.text).toBe("用户（何伟健&heweijian）确认");
  });

  it("大小写不敏感", () => {
    const r = sanitizeUserAttribution("用户（HEWEIJIAN）确认", WL);
    expect(r.text).toBe("用户（HEWEIJIAN）确认");
  });

  it("分隔符两侧有空格也能正确切分", () => {
    const r = sanitizeUserAttribution("用户（何伟健 / heweijian）确认", WL);
    expect(r.text).toBe("用户（何伟健 / heweijian）确认");
  });
});

describe("复合标签：任一段不命中 → 整串丢弃", () => {
  it("用户本人 + 第三方姓名", () => {
    const r = sanitizeUserAttribution("用户（何伟健/王缘林）联合确认", WL);
    expect(r.text).toBe("用户联合确认");
    expect(r.dropped).toEqual(["何伟健/王缘林"]);
  });

  it("用户本人 + 路径数字", () => {
    const r = sanitizeUserAttribution("用户（何伟健/28951）联合确认", WL);
    expect(r.text).toBe("用户联合确认");
  });

  it("全部第三方", () => {
    const r = sanitizeUserAttribution("用户（张三/李四）开会", WL);
    expect(r.text).toBe("用户开会");
    expect(r.dropped).toEqual(["张三/李四"]);
  });

  it("空白名单 → 复合标签整体丢弃", () => {
    const r = sanitizeUserAttribution("用户（何伟健/heweijian）确认", []);
    expect(r.text).toBe("用户确认");
  });
});

describe("复合标签：边界", () => {
  it("单段标签行为不变（等价于非复合）", () => {
    const r = sanitizeUserAttribution("用户（何伟健）确认", WL);
    expect(r.text).toBe("用户（何伟健）确认");
  });

  it("空分段被忽略（用户（/何伟健））", () => {
    const r = sanitizeUserAttribution("用户（/何伟健）确认", WL);
    expect(r.text).toBe("用户（/何伟健）确认");
  });

  it("自指词复合（用户（我/本人））整体归一", () => {
    const r = sanitizeUserAttribution("用户（我/本人）同意", WL);
    expect(r.text).toBe("用户同意");
    expect(r.dropped).toEqual([]);
  });

  it("自指词与第三方混合（用户（我/王缘林））→ 丢弃", () => {
    const r = sanitizeUserAttribution("用户（我/王缘林）同意", WL);
    expect(r.text).toBe("用户同意");
    expect(r.dropped).toEqual(["我/王缘林"]);
  });

  it("超长括号内容（>60 字符）不吞", () => {
    const long = "x".repeat(80);
    const text = `用户（${long}）说话`;
    const r = sanitizeUserAttribution(text, WL);
    expect(r.text).toBe(text);
  });

  it("dropped 去重保序", () => {
    const r = sanitizeUserAttribution("用户（张三）a；用户（李四）b；用户（张三）c", WL);
    expect(r.dropped).toEqual(["张三", "李四"]);
  });
});

describe("复合标签：异常输入", () => {
  it("空串原样返回", () => {
    expect(sanitizeUserAttribution("", WL)).toEqual({ text: "", dropped: [] });
  });

  it("undefined 白名单不抛异常", () => {
    const r = sanitizeUserAttribution("用户（张三）a", undefined);
    expect(r.text).toBe("用户a");
  });

  it("白名单含空串/空白项被忽略", () => {
    const r = sanitizeUserAttribution("用户（何伟健）a", ["", "  ", "何伟健"]);
    expect(r.text).toBe("用户（何伟健）a");
  });
});
