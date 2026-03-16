# AI Red Teaming Engine — VS Code Extension

[![Version](https://img.shields.io/badge/version-0.1.0-blue)](https://github.com/kagioneko/ai-red-teaming-engine-vscode)
[![VS Code](https://img.shields.io/badge/VS%20Code-1.85%2B-007ACC)](https://code.visualstudio.com/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

Real-time security vulnerability detection for VS Code and Cursor — powered by [AI Red Teaming Engine](https://github.com/kagioneko/ai-red-teaming-engine).

![Demo](https://raw.githubusercontent.com/kagioneko/ai-red-teaming-engine-vscode/main/docs/demo.png)

---

## Features

- **Auto-scan on save** — scans your file every time you save
- **Inline diagnostics** — red/yellow underlines on vulnerable code
- **Problems panel** — all issues listed with severity, category, and fix suggestions
- **Status bar** — scan results always visible at a glance
- **Manual scan** — run from command palette or right-click menu
- **Workspace scan** — scan all files at once

---

## Requirements

- [AI Red Teaming Engine](https://github.com/kagioneko/ai-red-teaming-engine) installed
- Python 3.10+
- At least one LLM backend available (Claude CLI, Gemini CLI, or Anthropic API key)

---

## Installation

### 1. Install the engine

```bash
git clone https://github.com/kagioneko/ai-red-teaming-engine.git
cd ai-red-teaming-engine
pip install click pydantic anthropic
```

### 2. Build the extension

```bash
git clone https://github.com/kagioneko/ai-red-teaming-engine-vscode.git
cd ai-red-teaming-engine-vscode
npm install
npx vsce package
# → ai-red-teaming-engine-0.1.0.vsix
```

### 3. Install in VS Code / Cursor

```bash
code --install-extension ai-red-teaming-engine-0.1.0.vsix
```

Or: Extensions sidebar → `...` → `Install from VSIX...`

---

## Configuration

Add to your `settings.json`:

```json
{
  "redteam.enginePath": "/path/to/ai-red-teaming-engine/engine.py",
  "redteam.mode": "deep",
  "redteam.backend": "claude",
  "redteam.scanOnSave": true,
  "redteam.minSeverityToShow": "Medium"
}
```

| Setting | Description | Default |
|---------|-------------|---------|
| `enginePath` | Path to `engine.py` | auto-detect |
| `mode` | Scan mode: `safe` / `deep` / `agent-audit` | `deep` |
| `backend` | LLM backend: `auto` / `claude` / `gemini` / `api` | `auto` |
| `scanOnSave` | Auto-scan on file save | `true` |
| `minSeverityToShow` | Minimum severity to show: `Critical` / `High` / `Medium` / `Low` / `Info` | `Medium` |
| `timeoutSeconds` | Scan timeout in seconds | `120` |

---

## Commands

| Command | Description |
|---------|-------------|
| `RedTeam: ファイルをスキャン` | Scan the active file |
| `RedTeam: ワークスペース全体をスキャン` | Scan the entire workspace |
| `RedTeam: 診断結果をクリア` | Clear all diagnostics |

Access via `Ctrl+Shift+P` (macOS: `Cmd+Shift+P`).

---

## Severity Levels

| Display | Severity | Meaning |
|---------|----------|---------|
| 🔴 Red underline | Critical / High | Fix immediately |
| 🟡 Yellow underline | Medium | Review recommended |
| 🔵 Blue underline | Low | Consider fixing |
| Gray underline | Info | Informational |

---

## Supported Languages

Python · JavaScript · TypeScript · Go · Java

---

## LSP Support (Neovim / Zed / Emacs)

Prefer a language server over an editor-specific extension? Use the LSP server instead:

```bash
pip install 'ai-red-teaming-engine[lsp]'
redteam-lsp  # starts the LSP server on stdio
```

See [LSP setup guide](https://github.com/kagioneko/ai-red-teaming-engine#lsp) for Neovim/Zed/Emacs configuration.

---

## Related

- [AI Red Teaming Engine](https://github.com/kagioneko/ai-red-teaming-engine) — the core engine
- [NeuroState Engine](https://github.com/kagioneko/neurostate-engine) — emotional state modeling for AI agents

---

## License

MIT © [Emilia Lab](https://kagioneko.com/emilia_lab/)
