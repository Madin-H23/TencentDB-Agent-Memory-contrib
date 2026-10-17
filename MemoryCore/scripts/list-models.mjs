// list-models.mjs <provider-name|current> [yamlPath] —— v3 版（2026-10-16 自 v2 移植）
// 读取 tdai-gateway.yaml 指定厂商的 baseUrl/apiKeyEnv，代发 GET {baseUrl}/models，
// 输出可用模型 id 清单供抄入目录/models 字段。key 经环境变量引用，不落盘、不回显。
// 与 v2 版的差异：v3 yaml 是单厂商结构（llm.baseUrl 直连，无 providers[]）——
// provider 传 "current" 或留空读单厂商块（apiKey 取 ${VAR} 插值形态的变量名，
// headers 一并发送，opencode-go 的 x-opencode-session 类专项头不漏）；
// yaml 若仍是 v2 providers[] 形态则按名查找（回滚场景可用）。
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const provider = process.argv[2] ?? "current";
const yamlPath = process.argv[3] ?? fileURLToPath(new URL("../tdai-gateway.yaml", import.meta.url));

const data = YAML.parse(fs.readFileSync(yamlPath, "utf-8"));
const llm = data?.llm ?? {};

let entry;
if (Array.isArray(llm.providers) && llm.providers.length > 0) {
  entry = llm.providers.find((p) => p.name === provider);
  if (!entry) {
    console.error(`未找到厂商 "${provider}" (可用: ${llm.providers.map((p) => p.name).join(", ") || "(空)"})`);
    process.exit(1);
  }
} else {
  // v3 单厂商形态
  const label = llm.providerLabel ?? "(未命名)";
  if (provider !== "current" && provider !== label) {
    console.error(`yaml 为 v3 单厂商形态（生效: ${label}）。用 "current" 或 "${label}" 查询`);
    process.exit(1);
  }
  const apiKeyRaw = String(llm.apiKey ?? "");
  const envFromInterp = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(apiKeyRaw)?.[1] ?? "";
  entry = {
    name: label,
    baseUrl: llm.baseUrl ?? "",
    apiKeyEnv: envFromInterp,
    headers: llm.headers ?? {},
  };
}

const keyEnv = entry.apiKeyEnv ?? "";
const key = keyEnv ? process.env[keyEnv] : undefined;
if (!key) {
  console.error(`环境变量 ${keyEnv || "(条目未配置 apiKeyEnv)"} 未设置或为空，无法调用 GET /models`);
  process.exit(1);
}

const base = String(entry.baseUrl ?? "").replace(/\/+$/, "");
if (!base) {
  console.error(`厂商 "${provider}" 缺少 baseUrl`);
  process.exit(1);
}

const headers = { Authorization: `Bearer ${key}` };
for (const [k, v] of Object.entries(entry.headers ?? {})) headers[k] = String(v);

let resp;
try {
  resp = await fetch(`${base}/models`, { headers, signal: AbortSignal.timeout(30_000) });
} catch (err) {
  console.error(`请求失败: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
if (!resp.ok) {
  console.error(`GET ${base}/models → HTTP ${resp.status}`);
  process.exit(1);
}

const body = await resp.json();
const raw = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : [];
const ids = raw.map((m) => (typeof m === "string" ? m : m?.id ?? m?.name)).filter(Boolean);

if (ids.length === 0) {
  console.error("响应中未解析到模型清单(接口形态可能不同)，请人工确认");
  process.exit(1);
}
console.log(`# ${entry.name} (${base}) 共 ${ids.length} 个模型:`);
for (const id of [...ids].sort()) {
  console.log(`  - ${id}`);
}
