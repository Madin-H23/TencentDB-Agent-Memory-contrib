// 票 P2-A1 分支 B1：L1 归档层生命周期（pure 决策/配置解析，默认 off=零行为）。
// 背景：l1_records 无生命周期机制——检索域只增不减（2,522 行，11-10→11-12 +31/2天）；
// ⑦ recallRanking 只做排序衰减（w2·2^(-age/30d)），存储侧零动作。
// 田野分类（mem0=检索衰减〔⑦ 已有〕/ Letta=归档层〔本文件·缺〕/ LangMem=合并〔B3〕）。
// 政策 v1 = 年龄单信号（L1 级无 heat 列——heat 在 L2 META 侧；heat 精细化待 P3 touchL1Heat）。
// 政策判定口径：「计数差异不算结论性」沿用 P1-6b 审计口径。

export interface L1ArchiveConfig {
  enabled: boolean;
  /** shadow=只计量不写库；on=真实置位。 */
  mode: "shadow" | "on";
  /** updated_time 距今 > ageDays 天 → 可归档。 */
  ageDays: number;
  /** 场景保护清单：这些场景的记忆永不归档。 */
  protectScenes: string[];
}

export const L1_ARCHIVE_DEFAULT_AGE_DAYS = 90;

/**
 * 解析 `persona.l1Archive`（同款先例：parseFactSupersedeConfig 拒绝式）：
 * - undefined/null/false → undefined（off，零行为）
 * - true → { enabled:true, mode:"shadow", ageDays:90, protectScenes:[] }（安全默认=影子先量）
 * - 对象 → 透传 + 校验（ageDays>0、mode∈{shadow,on}、protectScenes 字符串数组）；非法 throw
 */
export function parseL1ArchiveConfig(raw: unknown): L1ArchiveConfig | undefined {
  if (raw === undefined || raw === null || raw === false) return undefined;
  if (raw === true) {
    return { enabled: true, mode: "shadow", ageDays: L1_ARCHIVE_DEFAULT_AGE_DAYS, protectScenes: [] };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("persona.l1Archive 必须为布尔或对象（{enabled, mode, ageDays, protectScenes}）");
  }
  const o = raw as Record<string, unknown>;
  const enabled = o.enabled ?? true;
  if (typeof enabled !== "boolean") throw new Error("persona.l1Archive.enabled 须为布尔");
  if (enabled === false) return undefined;
  const modeRaw = o.mode ?? "shadow";
  if (modeRaw !== "shadow" && modeRaw !== "on") {
    throw new Error(`persona.l1Archive.mode 非法: ${String(modeRaw)}（只允许 shadow|on）`);
  }
  const ageRaw = o.ageDays ?? L1_ARCHIVE_DEFAULT_AGE_DAYS;
  if (typeof ageRaw !== "number" || !Number.isFinite(ageRaw) || ageRaw <= 0) {
    throw new Error(`persona.l1Archive.ageDays 须为正数: ${String(ageRaw)}`);
  }
  let protect: string[] = [];
  if (o.protectScenes !== undefined) {
    if (!Array.isArray(o.protectScenes) || o.protectScenes.some((x) => typeof x !== "string")) {
      throw new Error("persona.l1Archive.protectScenes 须为字符串数组");
    }
    protect = o.protectScenes as string[];
  }
  return { enabled: true, mode: modeRaw, ageDays: ageRaw, protectScenes: protect };
}

/** 归档判定（pure）：enabled+mode=on 且年龄超阈且场景不在保护清单。 */
export function archiveDecision(params: {
  updatedTimeMs: number;
  sceneName: string | null;
  nowMs: number;
  cfg: L1ArchiveConfig;
}): boolean {
  const { updatedTimeMs, sceneName, nowMs, cfg } = params;
  if (!cfg.enabled || cfg.mode !== "on") return false;
  const ageMs = nowMs - updatedTimeMs;
  if (ageMs <= cfg.ageDays * 86_400_000) return false;
  if (sceneName && cfg.protectScenes.includes(sceneName)) return false;
  return true;
}

/** 归档候选计数（shadow 用）：输入行集，返回应归档的 record_id 列表（不写库）。 */
export function selectArchiveCandidates(
  rows: Array<{ record_id: string; scene_name: string | null; updated_time: string }>,
  cfg: L1ArchiveConfig,
  nowMs: number,
): string[] {
  return rows
    .filter((r) =>
      archiveDecision({
        updatedTimeMs: Date.parse(r.updated_time) || 0,
        sceneName: r.scene_name,
        nowMs,
        cfg: { ...cfg, mode: "on" },
      }),
    )
    .map((r) => r.record_id);
}
