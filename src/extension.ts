/**
 * AI Red Teaming Engine — VS Code 拡張
 *
 * 機能:
 * - ファイル保存時に自動スキャン（設定で無効化可能）
 * - Ctrl+Shift+P → "RedTeam: ファイルをスキャン" で手動実行
 * - 問題パネル・波線で結果を表示
 * - ステータスバーにスキャン状況を表示
 */

import * as vscode from "vscode";
import * as cp from "child_process";
import * as path from "path";
import * as fs from "fs";

// ─── 型定義 ────────────────────────────────────────────────────────────────

interface RedTeamIssue {
  title?: string;
  severity?: string;
  category?: string;
  description?: string;
  why_this_matters?: string;
  minimal_fix?: string;
  hardening_suggestion?: string;
  fix_suggestion?: string;
  line_start?: number;
  line_end?: number;
  evidence?: string;
  confidence?: string;
}

interface RedTeamReport {
  scan_id?: string;
  file_path?: string;
  issues?: RedTeamIssue[];
  summary?: {
    total_issues?: number;
    critical?: number;
    high?: number;
    medium?: number;
    low?: number;
    overall_risk?: string;
  };
  error?: string;
}

// ─── 定数 ─────────────────────────────────────────────────────────────────

const EXTENSION_ID = "redteam";
const DIAGNOSTIC_SOURCE = "AI RedTeam";

const SEV_ORDER: Record<string, number> = {
  Critical: 0,
  High: 1,
  Medium: 2,
  Low: 3,
  Info: 4,
};

// ─── グローバル状態 ────────────────────────────────────────────────────────

let diagnosticCollection: vscode.DiagnosticCollection;
let statusBarItem: vscode.StatusBarItem;
let outputChannel: vscode.OutputChannel;

// スキャン中のファイルを追跡（多重実行防止）
const scanningFiles = new Set<string>();

// ─── 活性化 ───────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext): void {
  outputChannel = vscode.window.createOutputChannel("AI RedTeam");
  diagnosticCollection = vscode.languages.createDiagnosticCollection(EXTENSION_ID);
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = "redteam.scanFile";
  statusBarItem.text = "$(shield) RedTeam";
  statusBarItem.tooltip = "AI Red Teaming Engine — クリックでスキャン";
  statusBarItem.show();

  // コマンド登録
  context.subscriptions.push(
    vscode.commands.registerCommand("redteam.scanFile", () => {
      const doc = vscode.window.activeTextEditor?.document;
      if (doc) scanDocument(doc);
      else vscode.window.showWarningMessage("RedTeam: スキャン対象のファイルがありません");
    }),

    vscode.commands.registerCommand("redteam.scanWorkspace", scanWorkspace),

    vscode.commands.registerCommand("redteam.clearDiagnostics", () => {
      diagnosticCollection.clear();
      setStatusIdle();
      outputChannel.appendLine("[RedTeam] 診断結果をクリアしました");
    }),

    // 保存時スキャン
    vscode.workspace.onDidSaveTextDocument((doc) => {
      const cfg = getConfig();
      if (cfg.scanOnSave && isSupportedLanguage(doc.languageId)) {
        scanDocument(doc);
      }
    }),

    // アクティブエディタ切り替え時にステータスバー更新
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor) updateStatusBarForFile(editor.document.uri);
    }),

    diagnosticCollection,
    statusBarItem,
    outputChannel,
  );

  outputChannel.appendLine("[RedTeam] 拡張機能が起動しました");

  // 起動時に現在開いているファイルをスキャン
  const activeDoc = vscode.window.activeTextEditor?.document;
  if (activeDoc && isSupportedLanguage(activeDoc.languageId)) {
    const cfg = getConfig();
    if (cfg.scanOnSave) scanDocument(activeDoc);
  }
}

export function deactivate(): void {
  diagnosticCollection?.dispose();
  statusBarItem?.dispose();
  outputChannel?.dispose();
}

// ─── スキャン実行 ──────────────────────────────────────────────────────────

async function scanDocument(doc: vscode.TextDocument): Promise<void> {
  const filePath = doc.uri.fsPath;

  // 保存されていない場合は一時保存を促す
  if (doc.isDirty) {
    const choice = await vscode.window.showInformationMessage(
      "RedTeam: ファイルが保存されていません。保存してスキャンしますか？",
      "保存してスキャン",
      "キャンセル",
    );
    if (choice !== "保存してスキャン") return;
    await doc.save();
  }

  // 多重実行防止
  if (scanningFiles.has(filePath)) {
    outputChannel.appendLine(`[RedTeam] スキャン中: ${path.basename(filePath)}`);
    return;
  }

  scanningFiles.add(filePath);
  setStatusScanning(path.basename(filePath));
  outputChannel.appendLine(`[RedTeam] スキャン開始: ${filePath}`);

  try {
    const report = await runEngine(filePath);
    applyDiagnostics(doc.uri, report);
    updateStatusBarFromReport(report);
    showScanSummary(report, path.basename(filePath));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    outputChannel.appendLine(`[RedTeam] エラー: ${msg}`);
    vscode.window.showErrorMessage(`RedTeam スキャンエラー: ${msg}`);
    setStatusError();
  } finally {
    scanningFiles.delete(filePath);
  }
}

async function scanWorkspace(): Promise<void> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) {
    vscode.window.showWarningMessage("RedTeam: ワークスペースが開かれていません");
    return;
  }

  const cfg = getConfig();
  const enginePath = resolveEnginePath(cfg.enginePath);
  if (!enginePath) {
    showEngineNotFoundError();
    return;
  }

  const folder = folders[0].uri.fsPath;
  setStatusScanning("ワークスペース");
  outputChannel.appendLine(`[RedTeam] ワークスペーススキャン開始: ${folder}`);

  try {
    const args = buildArgs(cfg, undefined, folder);
    const result = await execEngine(enginePath, args, cfg.timeoutSeconds * 1000);
    const report = parseOutput(result);

    // ディレクトリスキャン結果（file_reports形式）を処理
    if (report.error) throw new Error(report.error);

    outputChannel.appendLine(`[RedTeam] ワークスペーススキャン完了`);
    vscode.window.showInformationMessage(
      `RedTeam: ワークスペーススキャン完了 — 詳細は出力パネルを確認`
    );
    setStatusIdle();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    outputChannel.appendLine(`[RedTeam] エラー: ${msg}`);
    vscode.window.showErrorMessage(`RedTeam ワークスペーススキャンエラー: ${msg}`);
    setStatusError();
  }
}

// ─── エンジン呼び出し ──────────────────────────────────────────────────────

async function runEngine(filePath: string): Promise<RedTeamReport> {
  const cfg = getConfig();
  const enginePath = resolveEnginePath(cfg.enginePath);

  if (!enginePath) {
    showEngineNotFoundError();
    throw new Error("engine.py が見つかりません");
  }

  const args = buildArgs(cfg, filePath);
  outputChannel.appendLine(`[RedTeam] 実行: python3 ${enginePath} ${args.join(" ")}`);

  const raw = await execEngine(enginePath, args, cfg.timeoutSeconds * 1000);
  return parseOutput(raw);
}

function buildArgs(
  cfg: ReturnType<typeof getConfig>,
  filePath?: string,
  dirPath?: string,
): string[] {
  const args: string[] = [];

  if (filePath) {
    args.push("--file", filePath);
  } else if (dirPath) {
    args.push("--dir", dirPath);
  }

  args.push("--mode", cfg.mode);
  args.push("--format", "json");
  args.push("--no-save-log");

  if (cfg.backend !== "auto") {
    args.push("--backend", cfg.backend);
  }

  return args;
}

function execEngine(enginePath: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";

    const proc = cp.spawn("python3", [enginePath, ...args], {
      timeout: timeoutMs,
    });

    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.stderr.on("data", (d) => {
      stderr += d.toString();
      outputChannel.append(`[stderr] ${d.toString()}`);
    });

    proc.on("error", (err) => reject(new Error(`プロセス起動失敗: ${err.message}`)));

    proc.on("close", (code) => {
      // exit code 1 は --fail-on による正常終了の場合もある
      if (code !== null && code > 1) {
        reject(new Error(`engine.py が終了コード ${code} で失敗\n${stderr}`));
        return;
      }
      resolve(stdout);
    });
  });
}

function parseOutput(raw: string): RedTeamReport {
  // JSON 部分を抜き出す（ログ出力が混在する場合を考慮）
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    outputChannel.appendLine(`[RedTeam] 出力全体:\n${raw}`);
    throw new Error("JSON 出力が見つかりませんでした");
  }
  try {
    return JSON.parse(jsonMatch[0]) as RedTeamReport;
  } catch (e) {
    throw new Error(`JSON パースエラー: ${e}`);
  }
}

// ─── 診断（波線・問題パネル）─────────────────────────────────────────────

function applyDiagnostics(uri: vscode.Uri, report: RedTeamReport): void {
  const cfg = getConfig();
  const minSevOrder = SEV_ORDER[cfg.minSeverityToShow] ?? SEV_ORDER["Medium"];

  const diagnostics: vscode.Diagnostic[] = [];
  const issues = report.issues ?? [];

  for (const issue of issues) {
    const sev = issue.severity ?? "Info";
    if ((SEV_ORDER[sev] ?? 99) > minSevOrder) continue;

    const range = buildRange(issue);
    const diag = new vscode.Diagnostic(range, buildMessage(issue), toDiagnosticSeverity(sev));
    diag.source = DIAGNOSTIC_SOURCE;
    diag.code = issue.category ?? sev;

    // 修正提案があればホバーに追加
    const fix = issue.minimal_fix ?? issue.hardening_suggestion ?? issue.fix_suggestion;
    if (fix) {
      diag.message += `\n💡 ${fix}`;
    }

    diagnostics.push(diag);
  }

  diagnosticCollection.set(uri, diagnostics);
  outputChannel.appendLine(
    `[RedTeam] ${diagnostics.length} 件の診断を設定 (合計 ${issues.length} 件中、フィルター後)`,
  );
}

function buildRange(issue: RedTeamIssue): vscode.Range {
  const startLine = Math.max(0, (issue.line_start ?? 1) - 1);
  const endLine = Math.max(startLine, (issue.line_end ?? issue.line_start ?? 1) - 1);
  return new vscode.Range(
    new vscode.Position(startLine, 0),
    new vscode.Position(endLine, Number.MAX_SAFE_INTEGER),
  );
}

function buildMessage(issue: RedTeamIssue): string {
  const title = issue.title ?? "(タイトルなし)";
  const desc = issue.why_this_matters ?? issue.description ?? "";
  return desc ? `${title}\n${desc}` : title;
}

function toDiagnosticSeverity(sev: string): vscode.DiagnosticSeverity {
  switch (sev) {
    case "Critical":
    case "High":
      return vscode.DiagnosticSeverity.Error;
    case "Medium":
      return vscode.DiagnosticSeverity.Warning;
    case "Low":
      return vscode.DiagnosticSeverity.Information;
    default:
      return vscode.DiagnosticSeverity.Hint;
  }
}

// ─── ステータスバー ────────────────────────────────────────────────────────

function setStatusScanning(label: string): void {
  statusBarItem.text = `$(sync~spin) RedTeam: ${label} スキャン中…`;
  statusBarItem.backgroundColor = undefined;
}

function setStatusIdle(): void {
  statusBarItem.text = "$(shield) RedTeam";
  statusBarItem.backgroundColor = undefined;
}

function setStatusError(): void {
  statusBarItem.text = "$(warning) RedTeam: エラー";
  statusBarItem.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
}

function updateStatusBarFromReport(report: RedTeamReport): void {
  const s = report.summary ?? {};
  const critical = s.critical ?? 0;
  const high = (s as Record<string, number>)["high"] ?? 0;
  const total = s.total_issues ?? 0;

  if (critical > 0) {
    statusBarItem.text = `$(error) RedTeam: Critical ${critical}件`;
    statusBarItem.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
  } else if (high > 0) {
    statusBarItem.text = `$(warning) RedTeam: High ${high}件`;
    statusBarItem.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
  } else if (total > 0) {
    statusBarItem.text = `$(info) RedTeam: ${total}件`;
    statusBarItem.backgroundColor = undefined;
  } else {
    statusBarItem.text = "$(pass) RedTeam: クリーン";
    statusBarItem.backgroundColor = undefined;
  }
}

function updateStatusBarForFile(uri: vscode.Uri): void {
  const diags = diagnosticCollection.get(uri);
  if (!diags?.length) {
    setStatusIdle();
    return;
  }
  const errors = diags.filter((d) => d.severity === vscode.DiagnosticSeverity.Error).length;
  const warnings = diags.filter((d) => d.severity === vscode.DiagnosticSeverity.Warning).length;

  if (errors > 0) {
    statusBarItem.text = `$(error) RedTeam: ${errors}件`;
    statusBarItem.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
  } else if (warnings > 0) {
    statusBarItem.text = `$(warning) RedTeam: ${warnings}件`;
    statusBarItem.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
  } else {
    statusBarItem.text = "$(pass) RedTeam: クリーン";
    statusBarItem.backgroundColor = undefined;
  }
}

// ─── 通知 ─────────────────────────────────────────────────────────────────

function showScanSummary(report: RedTeamReport, filename: string): void {
  const s = report.summary ?? {};
  const total = s.total_issues ?? 0;
  const critical = s.critical ?? 0;
  const high = (s as Record<string, number>)["high"] ?? 0;

  if (total === 0) {
    vscode.window.showInformationMessage(`RedTeam: ${filename} — 問題なし ✅`);
    return;
  }

  const parts: string[] = [];
  if (critical > 0) parts.push(`Critical: ${critical}`);
  if (high > 0) parts.push(`High: ${high}`);
  const rest = total - critical - high;
  if (rest > 0) parts.push(`その他: ${rest}`);

  const msg = `RedTeam: ${filename} — ${parts.join(", ")} (合計 ${total}件)`;

  if (critical > 0) {
    vscode.window.showErrorMessage(msg, "問題パネルを開く").then((choice) => {
      if (choice) vscode.commands.executeCommand("workbench.action.problems.focus");
    });
  } else if (high > 0) {
    vscode.window.showWarningMessage(msg);
  } else {
    vscode.window.showInformationMessage(msg);
  }
}

function showEngineNotFoundError(): void {
  vscode.window
    .showErrorMessage(
      "RedTeam: engine.py が見つかりません。設定で 'redteam.enginePath' を指定してください。",
      "設定を開く",
    )
    .then((choice) => {
      if (choice === "設定を開く") {
        vscode.commands.executeCommand("workbench.action.openSettings", "redteam.enginePath");
      }
    });
}

// ─── ユーティリティ ────────────────────────────────────────────────────────

function getConfig() {
  const cfg = vscode.workspace.getConfiguration(EXTENSION_ID);
  return {
    enginePath: cfg.get<string>("enginePath") ?? "",
    mode: cfg.get<string>("mode") ?? "deep",
    backend: cfg.get<string>("backend") ?? "auto",
    scanOnSave: cfg.get<boolean>("scanOnSave") ?? true,
    minSeverityToShow: cfg.get<string>("minSeverityToShow") ?? "Medium",
    timeoutSeconds: cfg.get<number>("timeoutSeconds") ?? 120,
  };
}

function resolveEnginePath(configPath: string): string | null {
  // 1. 設定で明示指定
  if (configPath && fs.existsSync(configPath)) return configPath;

  // 2. ワークスペースルートの engine.py
  const folders = vscode.workspace.workspaceFolders;
  if (folders) {
    for (const folder of folders) {
      const candidate = path.join(folder.uri.fsPath, "engine.py");
      if (fs.existsSync(candidate)) return candidate;
    }
  }

  // 3. redteam-scan コマンドが PATH にある場合は None を返す（将来対応）
  return null;
}

function isSupportedLanguage(languageId: string): boolean {
  return ["python", "javascript", "typescript", "go", "java"].includes(languageId);
}
