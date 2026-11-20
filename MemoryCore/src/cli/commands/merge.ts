/**
 * SPEC-E T05：影子 CLI（plan / execute / recover）。
 *
 * 只服务 Stage 1 影子验证：必须显式 --data-dir，拒绝生产数据目录，
 * 不接 L2 轮次、不注入提示词、不读生产 dataDir。输出统一为单行 JSON。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import type { SeedCliContext } from "../index.ts";
import { parseConfig } from "../../config.js";
import {
  executeMerge,
  parseMergeSceneConfig,
  planMerge,
  recoverMergeJournal,
  type MergeSceneConfig,
} from "../../core/scene/scene-merge.js";

const TAG = "[memory-tdai] [merge-cmd]";

/** 可注入的输出/退出通道，便于测试不污染进程状态。 */
export interface MergeCliIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

export type MergeCliExitSink = (code: number) => void;

interface CliState {
  exitCode: number;
}

class CliError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly exitCode = 2,
  ) {
    super(message);
  }
}

const PROD_DIR_SEGMENT = path.sep + ".memory-tencentdb" + path.sep;

/** 解析并拒绝生产数据目录；返回规范化绝对路径。 */
export function assertIsolatedDataDir(raw: string | undefined): string {
  if (!raw || raw.trim().length === 0) {
    throw new CliError("DATA_DIR_REQUIRED", "必须显式传 --data-dir，缺省不回落生产目录");
  }
  const resolved = path.resolve(raw);
  const real = fs.existsSync(resolved) ? fs.realpathSync(resolved) : resolved;
  const withSep = real.endsWith(path.sep) ? real : real + path.sep;
  const prodRoot = path.join(os.homedir(), ".memory-tencentdb") + path.sep;
  if (withSep.startsWith(prodRoot) || withSep.includes(PROD_DIR_SEGMENT)) {
    throw new CliError("PROD_DATA_DIR_FORBIDDEN", "拒绝生产数据目录：" + real);
  }
  if (!fs.existsSync(real) || !fs.statSync(real).isDirectory()) {
    throw new CliError("DATA_DIR_NOT_FOUND", "--data-dir 不存在或不是目录：" + real);
  }
  return real;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeConfig(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const current = out[key];
    out[key] = isPlainObject(current) && isPlainObject(value)
      ? mergeConfig(current, value)
      : value;
  }
  return out;
}

function loadPluginConfig(ctx: SeedCliContext, configFile: string | undefined): Record<string, unknown> {
  const base = isPlainObject(ctx.pluginConfig) ? ctx.pluginConfig : {};
  if (!configFile) return base;
  const resolved = path.resolve(configFile);
  if (!fs.existsSync(resolved)) {
    throw new CliError("CONFIG_NOT_FOUND", "配置文件不存在：" + resolved);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(resolved, "utf-8"));
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new CliError("CONFIG_INVALID", "配置文件不是合法 JSON：" + resolved + "（" + detail + "）");
  }
  if (!isPlainObject(parsed)) {
    throw new CliError("CONFIG_INVALID", "配置文件必须是 JSON 对象：" + resolved);
  }
  return mergeConfig(base, parsed);
}

interface RuntimeConfig {
  dataDir: string;
  cap: number;
  merge: MergeSceneConfig | undefined;
}

function parseCap(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new CliError("SCENE_CHAR_CAP_INVALID", "--scene-char-cap 必须是正整数，收到 " + raw);
  }
  return value;
}

function resolveRuntime(
  ctx: SeedCliContext,
  opts: { dataDir: string; config?: string; sceneCharCap?: string },
): RuntimeConfig {
  const dataDir = assertIsolatedDataDir(opts.dataDir);
  const pluginConfig = loadPluginConfig(ctx, opts.config);
  let parsed;
  try {
    parsed = parseConfig(pluginConfig);
  } catch (err) {
    throw new CliError("CONFIG_INVALID", err instanceof Error ? err.message : String(err));
  }
  const cap = parseCap(opts.sceneCharCap, parsed.persona.sceneCharCap);
  return { dataDir, cap, merge: parsed.persona.mergeScene };
}

function requireShadowConfig(rt: RuntimeConfig): MergeSceneConfig {
  if (!rt.merge || rt.merge.mode === "off") {
    throw new CliError(
      "MERGE_MODE_OFF",
      "persona.mergeScene 未启用（mode=off）；Stage 1 只允许显式 shadow 配置",
    );
  }
  return rt.merge;
}

function sceneDirOf(dataDir: string): string {
  return path.join(dataDir, "scene_blocks");
}

function readSceneFile(dataDir: string, filename: string): string {
  if (!filename || /[\\/]/.test(filename)) {
    throw new CliError("INVALID_INPUT", "场景文件名非法：" + filename);
  }
  const full = path.join(sceneDirOf(dataDir), filename);
  if (!fs.existsSync(full)) {
    throw new CliError("INVALID_INPUT", "场景文件不存在：" + filename);
  }
  return fs.readFileSync(full, "utf-8");
}

function listSceneNames(dataDir: string): string[] {
  const dir = sceneDirOf(dataDir);
  if (!fs.existsSync(dir)) {
    throw new CliError("INVALID_INPUT", "scene_blocks 不存在：" + dir);
  }
  return fs.readdirSync(dir).filter((name) => name.endsWith(".md")).sort();
}

function emit(io: MergeCliIo, payload: Record<string, unknown>): void {
  io.out(JSON.stringify(payload));
}

function handleError(err: unknown, io: MergeCliIo): number {
  if (err instanceof CliError) {
    emit(io, { ok: false, error: { code: err.code, message: err.message } });
    return err.exitCode;
  }
  const message = err instanceof Error ? err.message : String(err);
  emit(io, { ok: false, error: { code: "INTERNAL_ERROR", message } });
  io.err(TAG + " " + message);
  return 1;
}

// ============================
// Handlers
// ============================

interface PlanOptions {
  dataDir: string;
  a: string;
  b: string;
  target: string;
  config?: string;
  sceneCharCap?: string;
  now?: string;
}

function buildPlan(ctx: SeedCliContext, opts: PlanOptions) {
  const rt = resolveRuntime(ctx, opts);
  const config = requireShadowConfig(rt);
  const aRaw = readSceneFile(rt.dataDir, opts.a);
  const bRaw = readSceneFile(rt.dataDir, opts.b);
  return {
    rt,
    config,
    result: planMerge(
      { filename: opts.a, raw: aRaw },
      { filename: opts.b, raw: bRaw },
      {
        config,
        now: opts.now ?? new Date().toISOString(),
        target: opts.target,
        sceneCharCap: rt.cap,
        existingSceneNames: listSceneNames(rt.dataDir),
      },
    ),
  };
}

async function runPlanCommand(ctx: SeedCliContext, opts: PlanOptions, io: MergeCliIo): Promise<number> {
  const { result } = buildPlan(ctx, opts);
  if (!result.ok) {
    emit(io, { ok: false, command: "plan", error: result.rejection });
    return 2;
  }
  emit(io, {
    ok: true,
    command: "plan",
    key: result.plan.key,
    target: result.plan.target,
    concatOrder: result.plan.concatOrder,
    metrics: result.plan.metrics,
    a: { filename: result.plan.a.filename, chars: result.plan.a.chars },
    b: { filename: result.plan.b.filename, chars: result.plan.b.chars },
    c: { filename: result.plan.c.filename, chars: result.plan.c.chars },
  });
  return 0;
}

async function runExecuteCommand(ctx: SeedCliContext, opts: PlanOptions, io: MergeCliIo): Promise<number> {
  const { rt, config, result } = buildPlan(ctx, opts);
  if (!result.ok) {
    emit(io, { ok: false, command: "execute", error: result.rejection });
    return 2;
  }
  const executed = await executeMerge({
    plan: result.plan,
    config,
    sceneCharCap: rt.cap,
    dataDir: rt.dataDir,
  });
  if (!executed.ok) {
    emit(io, { ok: false, command: "execute", error: executed.error });
    return executed.error.code === "MERGE_UNSUPPORTED_ATOMICITY" ? 1 : 2;
  }
  emit(io, {
    ok: true,
    command: "execute",
    status: executed.status,
    key: executed.key,
    target: executed.target,
    journalStage: executed.journalStage,
    journalPath: executed.journalPath,
    preimageDir: executed.preimageDir,
    indexCount: executed.index.length,
    message: executed.message,
  });
  return 0;
}

interface RecoverOptions {
  dataDir: string;
  config?: string;
  sceneCharCap?: string;
  key?: string;
}

async function runRecoverCommand(ctx: SeedCliContext, opts: RecoverOptions, io: MergeCliIo): Promise<number> {
  const rt = resolveRuntime(ctx, opts);
  const config = rt.merge ?? parseMergeSceneConfig(true, rt.cap);
  if (!config) {
    throw new CliError("CONFIG_INVALID", "无法构造 mergeScene 恢复配置");
  }
  const recovered = await recoverMergeJournal({
    dataDir: rt.dataDir,
    config,
    key: opts.key,
  });
  if (!recovered.ok) {
    emit(io, {
      ok: false,
      command: "recover",
      error: recovered.error,
      outcomes: recovered.outcomes ?? [],
    });
    return recovered.error.code === "MERGE_UNSUPPORTED_ATOMICITY" ? 1 : 2;
  }
  emit(io, {
    ok: true,
    command: "recover",
    scanned: recovered.scanned,
    outcomes: recovered.outcomes,
    indexCount: recovered.index.length,
  });
  return 0;
}

// ============================
// Registration
// ============================

/** 构造 merge 子命令树。注册与测试共用，避免两套行为。 */
export function createMergeCommand(
  ctx: SeedCliContext,
  io: MergeCliIo,
  onExit: MergeCliExitSink,
  state: CliState,
) {
  const merge = new Command("merge").description(
    "Deterministic scene merge shadow tooling (SPEC-E Stage 1; never touches production dataDir)",
  );

  const guard = <T,>(fn: () => Promise<T>) => async () => {
    try {
      state.exitCode = (await fn()) as number;
    } catch (err) {
      state.exitCode = handleError(err, io);
    }
    onExit(state.exitCode);
  };

  merge.command("plan").description("Plan a merge; read-only, emits metrics JSON")
    .requiredOption("--data-dir <dir>", "隔离的数据目录（含 scene_blocks；拒绝生产目录）")
    .option("--config <file>", "JSON 配置覆盖文件（与插件配置深合并）")
    .option("--scene-char-cap <n>", "覆盖 persona.sceneCharCap")
    .requiredOption("--a <file>", "第一个场景文件名（相对 scene_blocks）")
    .requiredOption("--b <file>", "第二个场景文件名（相对 scene_blocks）")
    .requiredOption("--target <file>", "合并后场景文件名")
    .option("--now <iso>", "注入当前时间（ISO 8601；缺省取系统时间）")
    .action((opts: PlanOptions) => guard(() => runPlanCommand(ctx, opts, io))());

  merge.command("execute").description("Execute one planned merge on the isolated dataDir")
    .requiredOption("--data-dir <dir>", "隔离的数据目录（含 scene_blocks；拒绝生产目录）")
    .option("--config <file>", "JSON 配置覆盖文件（与插件配置深合并）")
    .option("--scene-char-cap <n>", "覆盖 persona.sceneCharCap")
    .requiredOption("--a <file>", "第一个场景文件名（相对 scene_blocks）")
    .requiredOption("--b <file>", "第二个场景文件名（相对 scene_blocks）")
    .requiredOption("--target <file>", "合并后场景文件名")
    .option("--now <iso>", "注入当前时间（ISO 8601；缺省取系统时间）")
    .action((opts: PlanOptions) => guard(() => runExecuteCommand(ctx, opts, io))());

  merge.command("recover").description("Recover interrupted merge journals on the isolated dataDir")
    .requiredOption("--data-dir <dir>", "隔离的数据目录（含 scene_blocks；拒绝生产目录）")
    .option("--config <file>", "JSON 配置覆盖文件（与插件配置深合并）")
    .option("--scene-char-cap <n>", "覆盖 persona.sceneCharCap")
    .option("--key <key>", "只恢复指定 merge key")
    .action((opts: RecoverOptions) => guard(() => runRecoverCommand(ctx, opts, io))());

  return merge;
}

function defaultIo(): MergeCliIo {
  return {
    out: (line) => process.stdout.write(line + "\n"),
    err: (line) => process.stderr.write(line + "\n"),
  };
}

/** 供真实 CLI 注册；退出码写 process.exitCode，不直接退出进程。 */
export function registerMergeCommand(parent: Command, ctx: SeedCliContext): void {
  const state: CliState = { exitCode: 0 };
  parent.addCommand(
    createMergeCommand(ctx, defaultIo(), (code) => {
      process.exitCode = code;
    }, state),
  );
}

/** 测试/脚本入口：解析 argv 并返回退出码。 */
export async function runMergeCli(
  argv: string[],
  ctx: SeedCliContext,
  io: MergeCliIo = defaultIo(),
): Promise<number> {
  const state: CliState = { exitCode: 0 };
  const program = createMergeCommand(ctx, io, (code) => {
    state.exitCode = code;
  }, state);
  program.exitOverride();

  // commander@5 没有 configureOutput（v6 才引入），帮助与用法错误直接写
  // process.stdout / console.error。这里只在测试/脚本入口短暂劫持两个写通道，
  // 把 commander 自己的输出也导向注入的 io；action 的 JSON 仍走 io。
  const stdoutWrite = process.stdout.write;
  const stderrWrite = process.stderr.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    io.out(String(chunk).replace(/\n$/, ""));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    io.err(String(chunk).replace(/\n$/, ""));
    return true;
  }) as typeof process.stderr.write;
  // commander@5 的用法错误走 console.error；一并接到注入的 err 通道，避免测试噪声。
  const consoleError = console.error;
  console.error = (...args: unknown[]) => {
    io.err(args.map((arg) => String(arg)).join(" "));
  };
  try {
    await program.parseAsync(["node", "merge", ...argv]);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "commander.helpDisplayed" || code === "commander.version") {
      return 0;
    }
    const message = err instanceof Error ? err.message : String(err);
    emit(io, { ok: false, error: { code: "CLI_USAGE", message } });
    return 2;
  } finally {
    console.error = consoleError;
    process.stdout.write = stdoutWrite;
    process.stderr.write = stderrWrite;
  }
  return state.exitCode;
}
