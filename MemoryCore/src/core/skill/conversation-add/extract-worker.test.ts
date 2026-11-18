import { describe, expect, it } from "vitest";
import { classifyError } from "./extract-worker.js";

describe("extract-worker · D 组：classifyError transient / permanent 二分", () => {
  it("permanent：HTTP 400/422 数据/schema 错", () => {
    expect(classifyError(Object.assign(new Error("request failed: 400"), {}))).toBe("permanent");
    expect(classifyError(new Error("validation failed 422"))).toBe("permanent");
  });

  it("permanent：JSON 解析 / schema / zod / invalid response 关键字", () => {
    expect(classifyError(new Error("JSON.parse unexpected token"))).toBe("permanent");
    expect(classifyError(new Error("invalid response shape"))).toBe("permanent");
    expect(classifyError(new Error("schema mismatch"))).toBe("permanent");
    expect(classifyError(new Error("zod validation failed"))).toBe("permanent");
  });

  it("transient：AbortError 保真", () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    expect(classifyError(abort)).toBe("transient");
  });

  it("transient：HTTP 401/403/429/5xx 额度与服务端", () => {
    expect(classifyError(new Error("rate limited 429"))).toBe("transient");
    expect(classifyError(new Error("HTTP 503 service unavailable"))).toBe("transient");
    expect(classifyError(new Error("401 unauthorized"))).toBe("transient");
  });

  it("transient：网络错误关键字", () => {
    expect(classifyError(new Error("connect ECONNREFUSED"))).toBe("transient");
    expect(classifyError(new Error("socket hang up"))).toBe("transient");
    expect(classifyError(new Error("fetch failed"))).toBe("transient");
    expect(classifyError(new Error("operation timeout"))).toBe("transient");
  });

  it("边界：空 message / 未知形态 → transient 兜底（保守不丢数据）", () => {
    expect(classifyError(new Error(""))).toBe("transient");
    expect(classifyError(new Error("totally unexpected xyz"))).toBe("transient");
  });

  it("优先级：permanent 关键字命中时即使含 429 也判 permanent", () => {
    expect(classifyError(new Error("invalid json (retry got 429)"))).toBe("permanent");
  });
});
