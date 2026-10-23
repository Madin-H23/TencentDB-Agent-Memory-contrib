// 票04 v2（2026-10-24）：layers.l2/l3.stream 假旋钮接真 —— tdai-core 装配点层。
//
// v1（工厂侧 enableTools:false + 原始 cfg.llm）被安全审查判 3×P1 后整体回退，v2
// 把层 runner 构造移到 tdai-core 装配点（正确层级）。本测试锁定三条 P1 的修复：
//   F1 enableTools 必须 true —— SceneExtractor 文档明言 Must be configured with
//      enableTools:true（scene-extractor.ts:~92），PersonaGenerator 靠模型工具直写
//      L3 文件（persona-generator.ts:213）；false 翻键即断 L2 场景块落盘与 L3 生成。
//   F2 config 必须来自 resolveRuntimeLlm(layer) 解析链 —— 绕过即 proxy 鉴权旁路 +
//      并发闸门分桶分裂。
//   F3 层覆盖必须生效 —— timeoutMs 取层值（600000）而非全局（120000）、thinkingLevel
//      透传；丢失即 L3 死信回归 + 修复动机失效。
// 另锁 F4：经 MetricTrackingRunnerFactory 装饰（credit/token 指标不恒 0）。
//
// 可测缝隙（ask v2 指定形态）：助手写成模块级导出函数 resolveL2l3StreamRunner
// （deps 注入 resolveRuntimeLlm/wrapFactory/logger），TdaiCore.l2l3StreamRunnerFor
// 私有方法薄封装调用之；生产 wrapFactory defaultL2l3StreamWrapFactory 以可选
// innerFactory 注入底层 factory spy —— enableTools:true 与 MetricTracking 包装
// 均可实证。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolveStandaloneLlmForRuntime } from "../adapters/standalone/llm-provider-resolver.js";
import { applyLlmLayerOverride } from "../adapters/standalone/llm-runner.js";
import { MetricTrackingRunner } from "./report/metric-tracking-runner.js";

const h = vi.hoisted(() => ({
  // wrapFactory（生产组装缝隙）的调用捕获：config 组装断言用
  wrapCaptured: [] as Array<{ config: Record<string, unknown> }>,
  // wrapFactory 返回的标记对象（助手必须原样返回它）
  wrapMarker: { run: async () => "" } as never,
  // 底层 factory spy 的 createRunner 参数捕获：enableTools 断言用
  innerFactoryCaptured: [] as Array<Record<string, unknown> | undefined>,
  // logger.info 行捕获：部署验证锚点（INFO 含层名/model/timeoutMs）用
  infoLines: [] as string[],
}));

// ── N1 装配锁（复审遗留）：pipeline-factory 工厂捕获 —— 保留其余导出，仅把四个
// create 工厂换成记录 opts 的 spy，用来锁住 TdaiCore 四个装配点传给 L2/L3 管道的
// 实际 runner（wire 路径 ~900/916 + runL2WithStore/runL3WithStore 路径 ~1305/1364）。
const pf = vi.hoisted(() => ({
  l1: [] as Array<Record<string, unknown>>,
  l2: [] as Array<Record<string, unknown>>,
  l3: [] as Array<Record<string, unknown>>,
}));

vi.mock("../utils/pipeline-factory.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils/pipeline-factory.js")>();
  const fakeRunnerFn = async () => undefined;
  return {
    ...actual,
    createL1Runner: (opts: Record<string, unknown>) => {
      pf.l1.push(opts);
      return fakeRunnerFn;
    },
    createL2Runner: (opts: Record<string, unknown>) => {
      pf.l2.push(opts);
      return fakeRunnerFn;
    },
    createL3Runner: (opts: Record<string, unknown>) => {
      pf.l3.push(opts);
      return fakeRunnerFn;
    },
  };
});

const { resolveL2l3StreamRunner, defaultL2l3StreamWrapFactory, TdaiCore } = await import("./tdai-core.js");

// 假 cfg（F3 断言的基准：全局 timeoutMs=120000，层覆盖 timeoutMs=600000 必须压过它）
function makeCfg(llmLayers?: Record<string, unknown>) {
  return {
    llm: {
      enabled: true,
      baseUrl: "https://upstream.invalid/v1",
      apiKey: "sk-test",
      model: "glm-5.3-flash",
      maxTokens: 8192,
      timeoutMs: 120_000,
      ...(llmLayers ? { layers: llmLayers } : {}),
    },
  } as never;
}

// 与 TdaiCore.resolveRuntimeLlm（tdai-core.ts:661-677）同构的最小复刻：
// 用真实导出解析函数组装，使 ② 的 timeoutMs/thinkingLevel 断言走端到端层解析路径
// （层覆盖引擎本身另有 llm-runner-layers.test.ts 覆盖）。
function makeResolveRuntimeLlm(cfg: ReturnType<typeof makeCfg>) {
  return (layer?: "l1" | "l2" | "l3") => {
    const resolved = resolveStandaloneLlmForRuntime((cfg as never as { llm: Record<string, unknown> }).llm as never, "iid-test");
    const base = {
      baseUrl: resolved.baseUrl,
      apiKey: resolved.apiKey,
      model: resolved.model,
      maxTokens: resolved.maxTokens ?? 4096,
      timeoutMs: resolved.timeoutMs ?? 120_000,
      stream: resolved.stream ?? false,
    };
    return applyLlmLayerOverride(base, layer ? (cfg as never as { llm: { layers?: Record<string, Record<string, unknown>> } }).llm.layers?.[layer] as never : undefined);
  };
}

function stubLogger() {
  return {
    debug: () => {},
    info: (...args: unknown[]) => {
      h.infoLines.push(String(args[0]));
    },
    warn: () => {},
    error: () => {},
  } as never;
}

// 原共享 runner 桩：键 off / base 缺省时必须原样返回它（同一实例）。
const baseRunner = { run: async () => "" } as never;

function spyWrapFactory(opts: { config: Record<string, unknown> }) {
  h.wrapCaptured.push(opts);
  return h.wrapMarker;
}

function makeDeps(cfg: ReturnType<typeof makeCfg>, wrapFactory = spyWrapFactory) {
  return {
    cfg,
    resolveRuntimeLlm: makeResolveRuntimeLlm(cfg),
    logger: stubLogger(),
    getInstanceId: () => "iid-test" as string | undefined,
    wrapFactory,
  };
}

describe("票04 v2 层流式 runner 决策：键判定与回落（零行为变化面）", () => {
  beforeEach(() => {
    h.wrapCaptured.length = 0;
    h.infoLines.length = 0;
    h.innerFactoryCaptured.length = 0;
  });

  it("① 键缺省 → 原样返回 base（同一实例），不构造不打 INFO", () => {
    const out = resolveL2l3StreamRunner("l2", baseRunner, makeDeps(makeCfg()));
    expect(out).toBe(baseRunner);
    expect(h.wrapCaptured.length).toBe(0);
    expect(h.infoLines.length).toBe(0);
  });

  it("① 键显式 false 与缺省等效（仍返回原 base 同一实例）", () => {
    const out = resolveL2l3StreamRunner("l2", baseRunner, makeDeps(makeCfg({ l2: { stream: false } })));
    expect(out).toBe(baseRunner);
    expect(h.wrapCaptured.length).toBe(0);
  });

  it("① base 缺省（undefined）→ 返回 undefined（即使键为 true 也不凭空构造）", () => {
    const out = resolveL2l3StreamRunner("l2", undefined, makeDeps(makeCfg({ l2: { stream: true } })));
    expect(out).toBeUndefined();
    expect(h.wrapCaptured.length).toBe(0);
  });

  it("① N2 守卫：llm.enabled=false 时拒绝信任层键（键 true 也不构造，返回原 base）", () => {
    // 对齐 shouldOverrideRunnerFactory 的既有判定（!cfg.llm.enabled → 拒绝）：
    // enabled=false 表示用户显式关闭 standalone LLM，cfg.llm 的其余字段不可信。
    const cfg = { llm: { ...(makeCfg({ l2: { stream: true } }) as { llm: Record<string, unknown> }).llm, enabled: false } } as never;
    const out = resolveL2l3StreamRunner("l2", baseRunner, makeDeps(cfg));
    expect(out).toBe(baseRunner);
    expect(h.wrapCaptured.length).toBe(0);
    expect(h.infoLines.length).toBe(0);
  });
});

describe("票04 v2 层流式 runner 决策：键 true 的构造参数契约（F2/F3）", () => {
  beforeEach(() => {
    h.wrapCaptured.length = 0;
    h.infoLines.length = 0;
    h.innerFactoryCaptured.length = 0;
  });

  it("② config 来自 resolveRuntimeLlm(layer)：层 timeoutMs=600000 压过全局 120000（F3）", () => {
    const cfg = makeCfg({ l2: { stream: true, timeoutMs: 600_000 } });
    const out = resolveL2l3StreamRunner("l2", baseRunner, makeDeps(cfg));
    expect(h.wrapCaptured.length).toBe(1);
    expect(h.wrapCaptured[0].config.timeoutMs).toBe(600_000); // 层覆盖生效，非全局 120000
    expect(out).toBe(h.wrapMarker); // 助手返回 wrapFactory 产物
  });

  it("② thinkingLevel 透传（F3：yaml l2 thinkingLevel=max 不再丢失）", () => {
    const cfg = makeCfg({ l2: { stream: true, thinkingLevel: "max" } });
    resolveL2l3StreamRunner("l2", baseRunner, makeDeps(cfg));
    expect(h.wrapCaptured[0].config.thinkingLevel).toBe("max");
  });

  it("② stream 强制 true（翻键的语义本体）且其余解析字段原样透传", () => {
    const cfg = makeCfg({ l2: { stream: true } });
    resolveL2l3StreamRunner("l2", baseRunner, makeDeps(cfg));
    expect(h.wrapCaptured[0].config.stream).toBe(true);
    expect(h.wrapCaptured[0].config.model).toBe("glm-5.3-flash");
    expect(h.wrapCaptured[0].config.baseUrl).toBe("https://upstream.invalid/v1");
  });

  it("② INFO 行含层名、l2.stream=on 与 timeoutMs/model 生效值（部署验证锚点）", () => {
    const cfg = makeCfg({ l2: { stream: true, timeoutMs: 600_000 } });
    resolveL2l3StreamRunner("l2", baseRunner, makeDeps(cfg));
    const info = h.infoLines.filter((l) => l.includes("[L2]") && l.includes("l2.stream=on"));
    expect(info.length).toBe(1);
    expect(info[0]).toContain("600000");
    expect(info[0]).toContain("glm-5.3-flash");
  });

  it("③ l2 键不影响 l3（l3 决策仍原样回落 base），l3 键同理不影响 l2", () => {
    const cfg = makeCfg({ l2: { stream: true, timeoutMs: 600_000 } });
    const l3Out = resolveL2l3StreamRunner("l3", baseRunner, makeDeps(cfg));
    expect(l3Out).toBe(baseRunner);
    expect(h.wrapCaptured.length).toBe(0); // l3 侧未因 l2.stream 构造

    const cfg2 = makeCfg({ l3: { stream: true, timeoutMs: 600_000 } });
    const l2Out = resolveL2l3StreamRunner("l2", baseRunner, makeDeps(cfg2));
    expect(l2Out).toBe(baseRunner);
    expect(h.wrapCaptured.length).toBe(0); // l2 侧未因 l3.stream 构造
  });
});

describe("票04 v2 生产 wrapFactory：enableTools 与 MetricTracking 包装（F1/F4）", () => {
  beforeEach(() => {
    h.wrapCaptured.length = 0;
    h.infoLines.length = 0;
    h.innerFactoryCaptured.length = 0;
  });

  it("enableTools:true 传给底层 factory（F1：false 即断 L2/L3 工具写盘链路）", () => {
    const innerSpy = {
      createRunner: (o?: Record<string, unknown>) => {
        h.innerFactoryCaptured.push(o);
        return baseRunner;
      },
    };
    defaultL2l3StreamWrapFactory({
      config: { baseUrl: "https://upstream.invalid/v1", apiKey: "k", model: "glm-5.3-flash", maxTokens: 8192, timeoutMs: 600_000, stream: true } as never,
      logger: stubLogger(),
      getInstanceId: () => "iid-test",
      innerFactory: innerSpy as never,
    });
    expect(h.innerFactoryCaptured.length).toBe(1);
    expect(h.innerFactoryCaptured[0]?.enableTools).toBe(true);
  });

  it("返回值经 MetricTrackingRunner 包装（F4：credit/token 指标不恒 0）", () => {
    const innerSpy = { createRunner: () => baseRunner };
    const out = defaultL2l3StreamWrapFactory({
      config: { baseUrl: "https://upstream.invalid/v1", apiKey: "k", model: "glm-5.3-flash", maxTokens: 8192, timeoutMs: 600_000, stream: true } as never,
      logger: stubLogger(),
      getInstanceId: () => "iid-test",
      innerFactory: innerSpy as never,
    });
    expect(out).toBeInstanceOf(MetricTrackingRunner);
  });
});

// ── N1 装配锁（复审遗留）：锁住 TdaiCore 四个装配点在层键 true 时传给 L2/L3
// 管道的是层流式变体而非原共享 runner。锁面：
//   - wire 路径（tdai-core.ts ~900/916，in-process scheduler）：同批构造下硬断言
//     l2/l3 收到的 runner 互不相同（各自层变体）——若仍是共享单例则两者必同；
//     off 对照断言 l2===l3（同一共享 l2l3LlmRunner 实例）。
//   - WithStore 路径（tdai-core.ts ~1305/1364，service 每请求）：捕获 runner 为
//     MetricTrackingRunner 包装 + INFO 行（l2l3.stream=on，层变体构造的唯一标记）
//     出现；off 对照无 INFO。
describe("票04 v2 N1 装配锁：四个装配点传入层流式变体而非原共享 runner", () => {
  beforeEach(() => {
    h.wrapCaptured.length = 0;
    h.infoLines.length = 0;
    h.innerFactoryCaptured.length = 0;
    pf.l1.length = 0;
    pf.l2.length = 0;
    pf.l3.length = 0;
  });

  function makeCore(llmLayers?: Record<string, unknown>, enabled = true) {
    // dataDir 仅被构造函数存值（mock 工厂不触盘），用假字符串免建临时目录。
    const wireDir = "D:/tmp-l2l3-wire-fake";
    const cfg = {
      extraction: { enabled: true },
      persona: {},
      llm: {
        enabled,
        baseUrl: "https://upstream.invalid/v1",
        apiKey: "sk-test",
        model: "glm-5.3-flash",
        maxTokens: 8192,
        timeoutMs: 120_000,
        ...(llmLayers ? { layers: llmLayers } : {}),
      },
    } as never;
    const hostAdapter = {
      hostType: "standalone",
      getRuntimeContext: () => ({ dataDir: wireDir }),
      getLogger: () => stubLogger(),
      getLLMRunnerFactory: () => ({ createRunner: () => baseRunner }),
    } as never;
    return new TdaiCore({ hostAdapter, config: cfg, instanceId: "iid-test" } as never) as {
      wirePipelineRunners: () => void;
      runL2WithStore: (sessionKey: string, store: unknown) => Promise<unknown>;
      runL3WithStore: (store: unknown) => Promise<unknown>;
    };
  }

  // fake scheduler：只记录 set 进来的闭包，wirePipelineRunners 不真正启动调度。
  function makeFakeScheduler() {
    const captured: Record<string, (sessionKey?: string) => Promise<unknown>> = {};
    return {
      captured,
      scheduler: {
        setL1Runner: (f: never) => {
          captured.l1 = f as never;
        },
        setL2Runner: (f: never) => {
          captured.l2 = f as never;
        },
        setL3Runner: (f: never) => {
          captured.l3 = f as never;
        },
        setPersister: () => {},
      },
    };
  }

  it("wire 路径（~900/916）：层键 true → L2/L3 闭包内 createL2/L3Runner 收到各自独立的流式变体（!== 共享单例形态）", async () => {
    const core = makeCore({ l2: { stream: true, timeoutMs: 600_000 }, l3: { stream: true } });
    const { scheduler, captured } = makeFakeScheduler();
    (core as unknown as { scheduler: unknown }).scheduler = scheduler;
    (core as unknown as { wirePipelineRunners: () => void }).wirePipelineRunners();

    // L1 在 wire 时同步构造；L2/L3 在任务闭包内构造 → 执行闭包触发捕获。
    expect(pf.l1.length).toBe(1);
    expect(captured.l2).toBeTypeOf("function");
    await (captured.l2 as (k: string) => Promise<unknown>)("sess-1");
    await (captured.l3 as () => Promise<unknown>)();

    expect(pf.l2.length).toBe(1);
    expect(pf.l3.length).toBe(1);
    // 各自独立的层变体（若仍是共享单例，两者必为同一实例）
    expect(pf.l2[0].llmRunner).toBeInstanceOf(MetricTrackingRunner);
    expect(pf.l3[0].llmRunner).toBeInstanceOf(MetricTrackingRunner);
    expect(pf.l2[0].llmRunner).not.toBe(pf.l3[0].llmRunner);
    // 层变体构造的直接标记：INFO 行（层构造路径唯一打出）
    expect(h.infoLines.filter((l) => l.includes("[L2]") && l.includes("l2.stream=on")).length).toBe(1);
    expect(h.infoLines.filter((l) => l.includes("[L3]") && l.includes("l3.stream=on")).length).toBe(1);
  });

  it("wire 路径对照（键缺省）：L2/L3 收到同一个共享 runner 实例（零行为变化）", async () => {
    const core = makeCore();
    const { scheduler, captured } = makeFakeScheduler();
    (core as unknown as { scheduler: unknown }).scheduler = scheduler;
    (core as unknown as { wirePipelineRunners: () => void }).wirePipelineRunners();
    await (captured.l2 as (k: string) => Promise<unknown>)("sess-1");
    await (captured.l3 as () => Promise<unknown>)();

    expect(pf.l2.length).toBe(1);
    expect(pf.l3.length).toBe(1);
    // 键缺省：两次闭包引用同一个共享 l2l3LlmRunner 变量 → 同一实例
    expect(pf.l2[0].llmRunner).toBe(pf.l3[0].llmRunner);
    expect(h.infoLines.filter((l) => l.includes("l2.stream=on")).length).toBe(0);
    expect(h.infoLines.filter((l) => l.includes("l3.stream=on")).length).toBe(0);
  });

  it("WithStore 路径（~1305/1364）：runL2WithStore/runL3WithStore 层键 true → 传入层流式变体（MetricTracking 包装 + INFO 标记）", async () => {
    const core = makeCore({ l2: { stream: true, timeoutMs: 600_000 }, l3: { stream: true } });
    const store = {} as never;
    await core.runL2WithStore("sess-1", store);
    await core.runL3WithStore(store);

    expect(pf.l2.length).toBe(1);
    expect(pf.l3.length).toBe(1);
    expect(pf.l2[0].llmRunner).toBeInstanceOf(MetricTrackingRunner);
    expect(pf.l3[0].llmRunner).toBeInstanceOf(MetricTrackingRunner);
    // 层变体构造标记（共享 runner 构造只打 debug，info 仅层路径有）
    expect(h.infoLines.filter((l) => l.includes("[L2]") && l.includes("l2.stream=on")).length).toBe(1);
    expect(h.infoLines.filter((l) => l.includes("[L3]") && l.includes("l3.stream=on")).length).toBe(1);
  });

  it("WithStore 路径对照（键缺省）：无 INFO 标记、仍为 MetricTracking 共享形态（零行为变化）", async () => {
    const core = makeCore();
    const store = {} as never;
    await core.runL2WithStore("sess-1", store);
    await core.runL3WithStore(store);

    expect(pf.l2.length).toBe(1);
    expect(pf.l3.length).toBe(1);
    expect(pf.l2[0].llmRunner).toBeInstanceOf(MetricTrackingRunner);
    expect(pf.l3[0].llmRunner).toBeInstanceOf(MetricTrackingRunner);
    expect(h.infoLines.filter((l) => l.includes("l2.stream=on")).length).toBe(0);
    expect(h.infoLines.filter((l) => l.includes("l3.stream=on")).length).toBe(0);
  });
});
