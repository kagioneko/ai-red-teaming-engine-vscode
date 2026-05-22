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
import {
  NeuroStateSession,
  fetchTurnScore,
  showAlertToast,
} from "./sessionMonitor";

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

// NeuroState セッション（グローバル1セッション）
let neuroSession: NeuroStateSession | null = null;
// セッション中にcheckTurnを実行した＝AI会話確認済みフラグ
let sessionVerified = false;

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

    // ─── NeuroState セッション監視コマンド ────────────────────────────────
    vscode.commands.registerCommand("redteam.startSessionMonitor", startSessionMonitor),
    vscode.commands.registerCommand("redteam.checkTurn", checkTurn),
    vscode.commands.registerCommand("redteam.resetSession", resetSession),
    vscode.commands.registerCommand("redteam.preCommitCheck", preCommitCheck),
    vscode.commands.registerCommand("redteam.investigateIssue", investigateIssue),

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
    await promptSessionCheckIfNeeded(report);
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
      if (code !== null && code > 1) {
        reject(classifyEngineError(stderr));
        return;
      }
      resolve(stdout);
    });
  });
}

function classifyEngineError(stderr: string): Error {
  if (stderr.includes("ANTHROPIC_API_KEY")) {
    return new Error(
      "ANTHROPIC_API_KEY が設定されていません。\n\n" +
      "以下のいずれかを設定してください:\n" +
      "  • ターミナルで: export ANTHROPIC_API_KEY=sk-ant-...\n" +
      "  • 設定で backend を 'claude'（Claude CLI）に変更する"
    );
  }
  if (stderr.includes("ModuleNotFoundError") || stderr.includes("No module named")) {
    const mod = stderr.match(/No module named '([^']+)'/)?.[1] ?? "依存パッケージ";
    return new Error(
      `Python パッケージ '${mod}' が見つかりません。\n` +
      `pip install ${mod} を実行してください。`
    );
  }
  if (stderr.includes("python3: can't open file") || stderr.includes("No such file")) {
    return new Error("engine.py が見つかりません。設定の 'redteam.enginePath' を確認してください。");
  }
  return new Error(`engine.py の実行に失敗しました。出力パネルで詳細を確認してください。\n${stderr.slice(0, 300)}`);
}

function parseOutput(raw: string): RedTeamReport {
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    outputChannel.appendLine(`[RedTeam] 出力全体:\n${raw}`);
    // stderr に原因が出ている場合はそちらを優先
    throw new Error("スキャン結果の取得に失敗しました。出力パネルを確認してください。");
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

    const conf = issue.confidence ?? "Medium";
    const range = buildRange(issue);
    const diag = new vscode.Diagnostic(range, buildMessage(issue), toDiagnosticSeverity(sev, conf));
    diag.source = DIAGNOSTIC_SOURCE;
    diag.code = issue.category ?? sev;

    // 修正提案があればホバーに追加
    const fix = issue.minimal_fix ?? issue.hardening_suggestion ?? issue.fix_suggestion;
    if (fix) {
      diag.message += `\n💡 ${fix}`;
    }

    // Low confidence には「詳しく調べる」タグを付与
    if (conf === "Low") {
      diag.tags = [vscode.DiagnosticTag.Unnecessary];
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

const CONFIDENCE_PREFIX: Record<string, string> = {
  High:   "🚨 確認済み脆弱性",
  Medium: "⚠️ 要確認",
  Low:    "💬 参考情報",
};

const CONFIDENCE_NOTE: Record<string, string> = {
  Low: "用途によっては安全な可能性があります。詳細調査が必要な場合は「詳しく調べる」を実行してください。",
};

function buildMessage(issue: RedTeamIssue): string {
  const title = issue.title ?? "(タイトルなし)";
  const conf = issue.confidence ?? "Medium";
  const prefix = CONFIDENCE_PREFIX[conf] ?? "";
  const desc = issue.why_this_matters ?? issue.description ?? "";
  const note = CONFIDENCE_NOTE[conf] ?? "";
  const parts = [`${prefix} — ${title}`];
  if (desc) parts.push(desc);
  if (note) parts.push(`ℹ️ ${note}`);
  return parts.join("\n");
}

function toDiagnosticSeverity(sev: string, confidence?: string): vscode.DiagnosticSeverity {
  // Low confidence は severity に関わらず Information 扱い
  if (confidence === "Low") return vscode.DiagnosticSeverity.Information;
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

// ─── NeuroState セッション監視 ─────────────────────────────────────────────

function getSessionConfig() {
  const cfg = vscode.workspace.getConfiguration(EXTENSION_ID);
  return {
    tDefault: cfg.get<number>("session.tDefault") ?? 0.7,
    windowN: cfg.get<number>("session.windowN") ?? 5,
  };
}

async function startSessionMonitor(): Promise<void> {
  const sessionCfg = getSessionConfig();
  neuroSession = new NeuroStateSession(sessionCfg.tDefault, sessionCfg.windowN);
  sessionVerified = false;
  outputChannel.appendLine(
    `[NeuroState] セッション監視を開始しました ` +
    `(T_default=${sessionCfg.tDefault}, window=${sessionCfg.windowN}ターン)`,
  );
  vscode.window.showInformationMessage(
    `NekoGuard: セッション監視を開始しました。` +
    `"RedTeam: ターンを検査" でAI会話のターンを監視できます。`,
  );
}

async function checkTurn(): Promise<void> {
  if (!neuroSession) {
    const start = await vscode.window.showWarningMessage(
      "NekoGuard: セッション監視が開始されていません。開始しますか？",
      "開始する",
      "キャンセル",
    );
    if (start !== "開始する") return;
    await startSessionMonitor();
  }

  const cfg = getConfig();
  const enginePath = resolveEnginePath(cfg.enginePath);
  if (!enginePath) {
    showEngineNotFoundError();
    return;
  }

  // 選択テキスト or 入力ボックスからターンテキストを取得
  const editor = vscode.window.activeTextEditor;
  let turnText = editor?.document.getText(editor.selection)?.trim() ?? "";

  if (!turnText) {
    const input = await vscode.window.showInputBox({
      prompt: "監視するAI会話のターンを貼り付けてください",
      placeHolder: "ユーザー入力 or AIレスポンスのテキスト...",
    });
    if (!input) return;
    turnText = input;
  }

  outputChannel.appendLine(`[NeuroState] ターン ${neuroSession!.turnCount + 1} を評価中...`);

  const { score, neurostate } = await fetchTurnScore(enginePath, turnText, cfg.backend === "auto" ? "claude" : cfg.backend, outputChannel);
  if (score < 0) {
    vscode.window.showErrorMessage("NekoGuard: スコアの取得に失敗しました。出力パネルを確認してください。");
    return;
  }

  const result = neuroSession!.update(score);
  result.neurostate = neurostate;
  const stats = neuroSession!.getStats();
  outputChannel.appendLine(
    `[NeuroState] ターン ${result.turnIndex}: ` +
    `V=${result.vCurrent.toFixed(2)}, A_long=${stats.aLong}, ` +
    `A_short=${stats.aShort}, L_trigger=${stats.lTrigger}` +
    (result.alert ? ` ⚠️ ${result.alertType}` : " ✅"),
  );

  if (!result.alert) {
    sessionVerified = true;
    vscode.window.showInformationMessage(
      `✅ NekoGuard: ターン ${result.turnIndex} — 異常なし (score=${result.vCurrent.toFixed(2)})`,
    );
    return;
  }

  // アラート発生
  const action = await showAlertToast(result);
  if (action === "ignore") {
    sessionVerified = true; // ユーザーが意図的にIgnoreした = 確認済みとみなす
  } else if (action === "reset") {
    neuroSession!.reset();
    sessionVerified = false;
    outputChannel.appendLine("[NeuroState] セッションをリセットしました");
    vscode.window.showInformationMessage("NekoGuard: 文脈をリセットしました。");
  } else if (action === "audit") {
    outputChannel.appendLine("[NeuroState] Opus で精密監査を開始します...");
    const doc = editor?.document;
    if (doc) {
      await scanDocument(doc);
    } else {
      vscode.window.showInformationMessage("NekoGuard: 監査対象のファイルを開いてから実行してください。");
    }
  }
}

async function resetSession(): Promise<void> {
  if (neuroSession) {
    neuroSession.reset();
    sessionVerified = false;
    outputChannel.appendLine("[NeuroState] セッションをリセットしました");
    vscode.window.showInformationMessage("NekoGuard: セッションをリセットしました。");
  } else {
    vscode.window.showInformationMessage("NekoGuard: アクティブなセッションがありません。");
  }
}

// ─── コミット前チェック ────────────────────────────────────────────────────

async function investigateIssue(): Promise<void> {
  const cfg = getConfig();
  const enginePath = resolveEnginePath(cfg.enginePath);
  if (!enginePath) {
    showEngineNotFoundError();
    return;
  }

  // 現在開いているファイルの診断からカテゴリを候補として提示
  const editor = vscode.window.activeTextEditor;
  const existingCategories: string[] = [];
  if (editor) {
    const diags = diagnosticCollection.get(editor.document.uri) ?? [];
    for (const d of diags) {
      const cat = typeof d.code === "string" ? d.code : String(d.code ?? "");
      if (cat && !existingCategories.includes(cat)) existingCategories.push(cat);
    }
  }

  let category: string | undefined;
  if (existingCategories.length > 0) {
    // 既存の診断カテゴリをクイックピックで選択
    const picks = existingCategories.map((c) => ({ label: c }));
    picks.push({ label: "その他（手動入力）" });
    const picked = await vscode.window.showQuickPick(picks, {
      placeHolder: "詳しく調べるカテゴリを選択してください",
    });
    if (!picked) return;
    if (picked.label === "その他（手動入力）") {
      category = await vscode.window.showInputBox({
        prompt: "カテゴリを入力してください",
        placeHolder: "例: Input Validation, Injection, Infra",
      });
    } else {
      category = picked.label;
    }
  } else {
    category = await vscode.window.showInputBox({
      prompt: "詳しく調べるカテゴリを入力してください",
      placeHolder: "例: Input Validation, Injection, Infra",
    });
  }
  if (!category) return;

  outputChannel.show();
  outputChannel.appendLine(`\n[RedTeam] 詳細調査: ${category} ...`);
  setStatusScanning(`調査中: ${category}`);

  try {
    const result = await execEngine(
      enginePath,
      ["--investigate", category, "--backend", cfg.backend === "auto" ? "claude" : cfg.backend],
      120_000,
    );
    outputChannel.appendLine(result);
    setStatusIdle();
    vscode.window.showInformationMessage(
      `🔍 詳細調査完了: ${category}`,
      "出力パネルを開く",
    ).then((choice) => {
      if (choice) outputChannel.show();
    });
  } catch (err) {
    outputChannel.appendLine(`[エラー] ${err}`);
    setStatusError();
    vscode.window.showErrorMessage(`詳細調査に失敗しました: ${err}`);
  }
}

async function preCommitCheck(): Promise<void> {
  // 確認済みなら即OK
  if (sessionVerified) {
    const stats = neuroSession?.getStats();
    const detail = stats
      ? `${stats.turns}ターン確認済み — 最終 A_long=${stats.aLong}, A_short=${stats.aShort}`
      : "セッション確認済み";
    vscode.window.showInformationMessage(
      `✅ NekoGuard: AI会話の確認済みです。コミットしてOK。`,
      { detail },
    );
    outputChannel.appendLine(`[NeuroState] コミット前チェック: 確認済み (${detail})`);
    return;
  }

  // 未確認の場合 → サマリーを出してチェックを促す
  const stats = neuroSession?.getStats();
  const sessionInfo = stats
    ? `現在のセッション: ${stats.turns}ターン / A_short=${stats.aShort} / L_trigger=${stats.lTrigger}`
    : "セッション監視未開始";

  const choice = await vscode.window.showWarningMessage(
    `⚠️ NekoGuard: AI会話がまだ確認されていません`,
    {
      modal: false,
      detail: `${sessionInfo}\nコミット前にAI会話のインジェクションチェックを推奨します。`,
    },
    "今すぐ確認する",
    "確認不要（スキップ）",
  );

  if (choice === "今すぐ確認する") {
    await checkTurn();
  } else if (choice === "確認不要（スキップ）") {
    sessionVerified = true;
    outputChannel.appendLine("[NeuroState] コミット前チェック: ユーザーがスキップを選択");
    vscode.window.showInformationMessage("NekoGuard: スキップしました。コミットを続行してください。");
  }
}

// ─── スキャン完了後の会話確認プロンプト ───────────────────────────────────

async function promptSessionCheckIfNeeded(report: RedTeamReport): Promise<void> {
  const cfg = vscode.workspace.getConfiguration(EXTENSION_ID);
  if (!cfg.get<boolean>("session.promptAfterCleanScan", true)) return;
  if (sessionVerified) return;

  const total = report.summary?.total_issues ?? 0;
  const critical = report.summary?.critical ?? 0;
  // コードに重大な問題がある場合はコード側を優先（会話チェックの前に直してもらう）
  if (critical > 0 || total > 5) return;

  const choice = await vscode.window.showInformationMessage(
    `✅ コードは問題なし。AIとの会話も確認しますか？`,
    "確認する",
    "今回はスキップ",
    "今後表示しない",
  );

  if (choice === "確認する") {
    if (!neuroSession) await startSessionMonitor();
    await checkTurn();
  } else if (choice === "今後表示しない") {
    await cfg.update("session.promptAfterCleanScan", false, vscode.ConfigurationTarget.Global);
  } else if (choice === "今回はスキップ") {
    sessionVerified = true;
  }
}
