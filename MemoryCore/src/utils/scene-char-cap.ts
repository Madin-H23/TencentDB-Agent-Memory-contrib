/**
 * 方案C（exp/l2-plan-c-write-cap）：L2 场景块写入后像尺寸帽。
 *
 * 背景：L2 场景文件增长的 94% 来自无后像约束的 edit（ newText 膨胀/重复批次段堆积），
 * 本帽在**落盘前**对写入后像（write 的 content / edit 应用替换后的完整内容）做字符数
 * 检查，超帽 → 拒绝且不落盘，返回结构化 JSON（含可执行的压缩指令 hint，防重试死锁）。
 *
 * 作用域：只对场景块前缀（storagePrefix 非空）生效；L3 persona（prefix 为空）不受限。
 * 开关：cap ≤ 0 或 undefined = off。
 *
 * 纯函数，storage-tools.ts 与 llm-runner.ts（本地沙箱）两处工具工厂共用同一口径。
 */

/** 默认帽（字符数），与 config.ts persona.sceneCharCap 缺省一致。 */
export const DEFAULT_SCENE_CHAR_CAP = 32_000;

/** 拒绝响应里的可执行压缩指令（红线：拒绝必须带，防模型原地重试死锁）。 */
export const SCENE_CHAR_CAP_HINT = "compress: 折叠重复批次段，保留事实锚点行";

/** 结构化拒绝体：JSON 序列化后作为工具响应返回给模型。 */
export interface SceneCharCapRejection {
  error: "over_scene_char_cap";
  chars: number;
  cap: number;
  overflow: number;
  hint: string;
}

/**
 * 检查写入后像是否超帽。
 *
 * @param content 写入后像（write 的 content；edit 为应用全部替换后的完整内容）
 * @param cap     字符帽；≤0 / undefined / NaN 视为 off
 * @returns 超帽 → 拒绝体；否则 null（放行）
 *
 * 注意：本函数内容无关 —— "[DELETED]" 豁免是 write 工具调用侧的策略（edit 后像
 * 不豁免），不在此处判定。
 */
export function checkSceneCharCap(
  content: string,
  cap: number | undefined,
): SceneCharCapRejection | null {
  if (cap === undefined || !Number.isFinite(cap) || cap <= 0) return null;
  const chars = content.length;
  if (chars <= cap) return null;
  return {
    error: "over_scene_char_cap",
    chars,
    cap,
    overflow: chars - cap,
    hint: SCENE_CHAR_CAP_HINT,
  };
}
