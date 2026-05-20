/**
 * NeuroState 動的プロンプトインジェクション検知
 *
 * 会話セッションを時系列データとして監視し、3つの指標で異常を検知する:
 *   T_default: 絶対防衛ライン（固定）
 *   A_long:    セッション全体の累積平均
 *   A_short:   直近 windowN ターンの移動平均
 *   L_trigger: (T_default + A_long) / 2  ← 動的トリガーライン
 *
 * 検知パターン:
 *   sudden:    V_current > T_default    → 突発型インジェクション
 *   slow_burn: A_short   > L_trigger   → じわじわ型（マルチターン）
 */

import * as cp from "child_process";
import * as path from "path";
import * as vscode from "vscode";

// ─── 型 ────────────────────────────────────────────────────────────────────

export type AlertType = "none" | "sudden" | "slow_burn";

export interface NeuroStateVector {
  desire: number;
  sorrow: number;
  calm: number;
  openness: number;
  guilt: number;
  euphoria: number;
  corruption: number;
}

export interface DetectionResult {
  alert: boolean;
  alertType: AlertType;
  vCurrent: number;
  aLong: number;
  aShort: number;
  lTrigger: number;
  tDefault: number;
  turnIndex: number;
  neurostate?: NeuroStateVector;
  message: string;
}

// ─── セッション状態 ─────────────────────────────────────────────────────────

export class NeuroStateSession {
  private history: number[] = [];
  private tDefault: number;
  private windowN: number;

  constructor(tDefault = 0.7, windowN = 5) {
    this.tDefault = tDefault;
    this.windowN = windowN;
  }

  get turnCount(): number {
    return this.history.length;
  }

  /**
   * Python engine から取得した V_current を受け取り、統計を更新して検知結果を返す。
   * LLM 呼び出しは engine.py 側で完結しているため、ここは純粋な計算のみ。
   */
  update(vCurrent: number): DetectionResult {
    this.history.push(vCurrent);

    const aLong = avg(this.history);
    const window = this.history.slice(-this.windowN);
    const aShort = avg(window);
    const lTrigger = (this.tDefault + aLong) / 2;

    let alertType: AlertType = "none";
    let message = "";

    if (vCurrent > this.tDefault) {
      alertType = "sudden";
      message =
        `突発型インジェクションを検知しました ` +
        `(score=${vCurrent.toFixed(2)} > threshold=${this.tDefault.toFixed(2)})`;
    } else if (aShort > lTrigger) {
      alertType = "slow_burn";
      message =
        `じわじわ型（マルチターン）インジェクションを検知しました ` +
        `(A_short=${aShort.toFixed(2)} > L_trigger=${lTrigger.toFixed(2)})`;
    }

    return {
      alert: alertType !== "none",
      alertType,
      vCurrent,
      aLong,
      aShort,
      lTrigger,
      tDefault: this.tDefault,
      turnIndex: this.turnCount,
      message,
    };
  }

  reset(): void {
    this.history = [];
  }

  getStats() {
    const window = this.history.slice(-this.windowN);
    const aLong = avg(this.history);
    const aShort = avg(window);
    return {
      turns: this.turnCount,
      aLong: round(aLong),
      aShort: round(aShort),
      lTrigger: round((this.tDefault + aLong) / 2),
      tDefault: this.tDefault,
    };
  }
}

function avg(arr: number[]): number {
  return arr.length === 0 ? 0 : arr.reduce((a, b) => a + b, 0) / arr.length;
}
function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

// ─── Engine 呼び出し ─────────────────────────────────────────────────────────

/**
 * engine.py --session-score でターンのリスクスコアを取得する。
 * 戻り値: 0.0-1.0 のスコア（エラー時は -1）
 */
export interface TurnScoreResult {
  score: number;
  neurostate?: NeuroStateVector;
}

export async function fetchTurnScore(
  enginePath: string,
  turnText: string,
  backend: string,
  outputChannel: vscode.OutputChannel,
): Promise<TurnScoreResult> {
  return new Promise((resolve) => {
    const args = [
      enginePath,
      "--session-score", turnText,
      "--backend", backend,
      "--no-save-log",
    ];

    let stdout = "";
    const proc = cp.spawn("python3", args, { timeout: 30_000 });
    proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on("data", (d: Buffer) => {
      outputChannel.append(`[NeuroState stderr] ${d.toString()}`);
    });
    proc.on("error", (err) => {
      outputChannel.appendLine(`[NeuroState] エンジン起動失敗: ${err.message}`);
      resolve({ score: -1 });
    });
    proc.on("close", () => {
      try {
        const parsed = JSON.parse(stdout.trim());
        resolve({
          score: typeof parsed.score === "number" ? parsed.score : -1,
          neurostate: parsed.neurostate as NeuroStateVector | undefined,
        });
      } catch {
        outputChannel.appendLine(`[NeuroState] スコアのパース失敗: ${stdout}`);
        resolve({ score: -1 });
      }
    });
  });
}

// ─── VS Code UX ─────────────────────────────────────────────────────────────

/**
 * アラート Toast を表示し、ユーザーの選択を返す。
 * 戻り値: "ignore" | "reset" | "audit" | undefined（閉じた）
 */
export async function showAlertToast(
  result: DetectionResult,
): Promise<"ignore" | "reset" | "audit" | undefined> {
  const typeLabel =
    result.alertType === "sudden"
      ? "突発型インジェクション"
      : "じわじわ型（マルチターン）インジェクション";

  const ns = result.neurostate;
  const nsDetail = ns
    ? `\ncorruption=${ns.corruption.toFixed(2)}  calm=${ns.calm.toFixed(2)}  ` +
      `openness=${ns.openness.toFixed(2)}  guilt=${ns.guilt.toFixed(2)}  euphoria=${ns.euphoria.toFixed(2)}`
    : "";

  const detail =
    `${typeLabel}の兆候を検知しました。\n` +
    `V=${result.vCurrent.toFixed(2)}  A_short=${result.aShort.toFixed(2)}  ` +
    `L_trigger=${result.lTrigger.toFixed(2)}  T_default=${result.tDefault.toFixed(2)}` +
    nsDetail;

  const choice = await vscode.window.showWarningMessage(
    `⚠️ NekoGuard: 文脈の異常な歪みを検知しました`,
    { modal: false, detail },
    "このまま続行 (Ignore)",
    "文脈をリセット (Reset)",
    "Opus で精密監査 (Audit)",
  );

  if (choice === "このまま続行 (Ignore)") return "ignore";
  if (choice === "文脈をリセット (Reset)") return "reset";
  if (choice === "Opus で精密監査 (Audit)") return "audit";
  return undefined;
}
