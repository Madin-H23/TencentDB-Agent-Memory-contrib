/**
 * L2 读取预算 —— S0 影子计量。
 *
 * 2026-10-23 决策（spec-a1-read-budget-test-20261023.md）：
 *   单文件 32,000 字符；单 run 累计 80,000 字符（字符口径，非 token）。
 *
 * S0 阶段只调用 observe() 记录读数，**不改变任何读/写行为**；
 * S1 才用同一模块做 read 截断与写侧校验。
 */

export const READ_BUDGET_ANCHOR = "read-budget";
export const READ_BUDGET_CHARS_PER_FILE = 32_000;
export const READ_BUDGET_CHARS_PER_RUN = 80_000;

export interface ReadBudgetObservation {
  /** 读取时的相对路径（日志用） */
  path: string;
  /** 本次读取的字符数 */
  chars: number;
  /** 本 run 到本次为止的累计字符数 */
  runChars: number;
  /** 本次读取是否超过单文件帽 */
  overFile: boolean;
  /** 本 run 累计是否已超过总量帽 */
  overRun: boolean;
  /** 本次读取是否正好跨过总量帽（用于精确计数，不在后续读取上重复） */
  crossedRunBudget: boolean;
}

/**
 * 每个 toolset（= 一次 LLM run）新建一个实例。
 * 一次 run 一份 toolset 的闭包生命周期见 llm-runner.ts 的 createSandboxedTools /
 * createStorageTools，故这里用实例计数即可，无需全局状态。
 */
export class ReadBudgetTracker {
  private runChars = 0;

  constructor(
    private readonly perFile: number = READ_BUDGET_CHARS_PER_FILE,
    private readonly perRun: number = READ_BUDGET_CHARS_PER_RUN,
  ) {}

  observe(filePath: string, chars: number): ReadBudgetObservation {
    const prev = this.runChars;
    this.runChars += chars;
    return {
      path: filePath,
      chars,
      runChars: this.runChars,
      overFile: chars > this.perFile,
      overRun: this.runChars > this.perRun,
      crossedRunBudget: prev <= this.perRun && this.runChars > this.perRun,
    };
  }

  get totalChars(): number {
    return this.runChars;
  }
}

/** 稳定锚点，便于日志 grep 与后续面板统计。 */
export function formatReadBudgetObservation(o: ReadBudgetObservation): string {
  return (
    `${READ_BUDGET_ANCHOR} path="${o.path}" chars=${o.chars} run_chars=${o.runChars} ` +
    `over_file=${o.overFile} over_run=${o.overRun} crossed_run=${o.crossedRunBudget}`
  );
}
