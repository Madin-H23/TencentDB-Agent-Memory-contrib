// list-models.mjs <provider-name> [yamlPath]
// 读取 tdai-gateway.yaml 指定厂商条目的 baseUrl/apiKeyEnv,代发 GET {baseUrl}/models,
// 输出可用模型 id 清单供抄入该厂商的 models 字段。key 经环境变量引用,不落盘、不回显。
// 由仓库根目录 list-models.sh 调用;依赖 MemoryCore/node_modules 的 yaml 包。
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const provider = process.argv[2];
if (!provider) {
  console.error("用法: list-models.mjs <provider-name>  (providers[].name, 见 tdai-gateway.yaml)");
  process.exit(1);
}
const yamlPath = process.argv[3] ?? fileURLToPath(new URL("../tdai-gateway.yaml", import.meta.url));

const data = YAML.parse(fs.readFileSync(yamlPath, "utf-8"));
const entries = data?.llm?.providers ?? [];
const entry = entries.find((p) => p.name === provider);
if (!entry) {
  console.error(
    `未找到厂商 "${provider}" (可用: ${entries.map((p) => p.name).join(", ") || "(空)"})`,
  );
  process.exit(1);
}

const keyEnv = entry.apiKeyEnv ?? "";
const key = keyEnv ? process.env[keyEnv] : undefined;
if (!key) {
  console.error(`环境变量 ${keyEnv || "(条目未配置 apiKeyEnv)"} 未设置或为空,无法调用 GET /models`);
  process.exit(1);
}

const base = (entry.baseUrl ?? "").replace(/\/+$/, "");
if (!base) {
  console.error(`厂商 "${provider}" 缺少 baseUrl`);
  process.exit(1);
}

let resp;
try {
  resp = await fetch(`${base}/models`, {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(30_000),
  });
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
  console.error("响应中未解析到模型清单(接口形态可能不同),请人工确认");
  process.exit(1);
}
console.log(`# ${provider} (${base}) 共 ${ids.length} 个模型:`);
for (const id of [...ids].sort()) {
  console.log(`  - ${id}`);
}
