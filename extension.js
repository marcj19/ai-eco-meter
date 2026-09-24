'use strict';
const vscode = require('vscode');
const crypto = require('crypto');
const { Collector } = require('./src/collector');
const { buildSnapshot, DEFAULT_MULTIPLIERS } = require('./src/impact');
const { EditorPets } = require('./src/editorPets');

const MANUAL_KEY = 'aiEcoMeter.manualEntries';

/** Presets para registrar uso de ferramentas sem log local. */
// Valores por pergunta divulgados pelas próprias empresas (média/mediana de um prompt de texto).
const OFFICIAL = {
  ChatGPT: { wh: 0.34, ml: 0.32, ref: 'OpenAI, 2025' },
  Gemini: { wh: 0.24, ml: 0.26, ref: 'Google, 2025' },
};

const PRESETS = [
  { label: '$(comment) Pergunta rápida', detail: '~200 tokens de entrada, ~400 de resposta', inTok: 200, outTok: 400, perPrompt: true },
  { label: '$(code) Resposta longa / geração de código', detail: '~1.500 de entrada, ~1.500 de resposta', inTok: 1500, outTok: 1500, perPrompt: true },
  { label: '$(file-text) Análise de documento/arquivo grande', detail: '~20.000 de entrada, ~1.500 de resposta', inTok: 20000, outTok: 1500 },
  { label: '$(search) Pesquisa profunda / agente', detail: '~150.000 de entrada, ~8.000 de resposta', inTok: 150000, outTok: 8000 },
  { label: '$(file-media) Geração de imagem', detail: '≈ 3 Wh por imagem (estimativa)', whFixed: 3 },
  { label: '$(edit) Personalizado…', detail: 'Informe os tokens de entrada e saída', custom: true },
];

const TOOLS = ['ChatGPT', 'GitHub Copilot', 'Gemini', 'Claude.ai', 'Cursor', 'Perplexity', 'Outro'];

let collector;
let statusItem;
let timer;
let latest = null;
let running = null;
const webviews = new Set();
let panel = null;
let ctx;
let editorPets;

function readCfg() {
  const c = vscode.workspace.getConfiguration('aiEcoMeter');
  return {
    claude: c.get('sources.claudeCode', true),
    codex: c.get('sources.codex', true),
    gemini: c.get('sources.geminiCli', true),
    antigravity: c.get('sources.antigravity', true),
    claudePath: c.get('paths.claudeCode', ''),
    codexPath: c.get('paths.codex', ''),
    geminiPath: c.get('paths.gemini', ''),
    antigravityPath: c.get('paths.antigravity', ''),
    dailyBudgetWh: c.get('dailyEnergyBudgetWh', 1000),
    whPer1kOutput: c.get('coefficients.whPer1kOutputTokens', 1),
    whPer1kInput: c.get('coefficients.whPer1kInputTokens', 0.1),
    whPer1kCacheWrite: c.get('coefficients.whPer1kCacheWriteTokens', 0.12),
    whPer1kCacheRead: c.get('coefficients.whPer1kCacheReadTokens', 0.01),
    waterLPerKWh: c.get('waterLitersPerKWh', 1.8),
    co2gPerKWh: c.get('gridCo2GramsPerKWh', 400),
    modelMultipliers: c.get('modelMultipliers', DEFAULT_MULTIPLIERS),
    refreshSeconds: Math.max(10, c.get('refreshIntervalSeconds', 60)),
    statusBar: c.get('showStatusBar', true),
    pets: { enabled: c.get('pets.enabled', true), list: c.get('pets.list', ['gato', 'capivara', 'pato']) },
    petsInEditor: c.get('pets.inEditor', false),
  };
}

function manualEntries() {
  return ctx.globalState.get(MANUAL_KEY, []);
}

async function refresh() {
  if (running) return running;
  running = (async () => {
    const cfg = readCfg();
    const { records, sources } = await collector.collect(cfg);
    const manual = manualEntries();
    for (const m of manual) records.push(m);
    sources.manual = { enabled: true, requests: manual.reduce((n, m) => n + (m.requests || 1), 0) };
    latest = buildSnapshot(records, sources, cfg);
    updateStatusBar(cfg);
    const pct = latest.ranges.today.wh / cfg.dailyBudgetWh;
    const mood = pct < 0.25 ? 'radiant' : pct < 0.6 ? 'calm' : pct < 1 ? 'worried' : 'hot';
    editorPets.update(cfg.pets, cfg.petsInEditor, mood);
    broadcast();
  })()
    .catch((err) => console.error('[AI Eco Meter]', err))
    .finally(() => {
      running = null;
    });
  return running;
}

function broadcast() {
  for (const w of webviews) w.postMessage({ type: 'snapshot', snapshot: latest });
}

// ------------------------------------------------------------------ status bar

function fmt(n, d) {
  return n.toLocaleString('pt-BR', { maximumFractionDigits: d, minimumFractionDigits: 0 });
}
function fmtEnergy(wh) {
  if (wh >= 1000) return fmt(wh / 1000, 2) + ' kWh';
  return fmt(wh, wh < 10 ? 2 : wh < 100 ? 1 : 0) + ' Wh';
}
function fmtWater(ml) {
  if (ml >= 1000) return fmt(ml / 1000, ml >= 100000 ? 0 : 1) + ' L';
  return fmt(ml, ml < 10 ? 1 : 0) + ' mL';
}
function fmtTokens(n) {
  if (n >= 1e9) return fmt(n / 1e9, 1) + ' bi';
  if (n >= 1e6) return fmt(n / 1e6, 1) + ' mi';
  if (n >= 1e3) return fmt(n / 1e3, 1) + ' mil';
  return fmt(n, 0);
}

function updateStatusBar(cfg) {
  if (!cfg.statusBar || !latest) {
    statusItem.hide();
    return;
  }
  const t = latest.ranges.today;
  const pct = t.wh / cfg.dailyBudgetWh;
  const mood = pct < 0.25 ? 'radiante' : pct < 0.6 ? 'tranquila' : pct < 1 ? 'preocupada' : 'com calor';
  statusItem.text = `$(globe) ${fmtEnergy(t.wh)} · ${fmtWater(t.ml)}`;
  const md = new vscode.MarkdownString(undefined, true);
  md.isTrusted = true;
  md.appendMarkdown(`**Pegada da IA hoje**, o planeta está *${mood}*\n\n`);
  md.appendMarkdown(`| | |\n|---|---|\n`);
  md.appendMarkdown(`| Energia | ${fmtEnergy(t.wh)} (${fmt(pct * 100, 0)}% da meta) |\n`);
  md.appendMarkdown(`| Água | ${fmtWater(t.ml)} |\n`);
  md.appendMarkdown(`| CO₂ | ${fmt(t.g, t.g < 10 ? 1 : 0)} g |\n`);
  md.appendMarkdown(`| Tokens | ${fmtTokens(t.tokens)} em ${fmt(t.requests, 0)} requisições |\n\n`);
  md.appendMarkdown(`[Abrir painel](command:aiEcoMeter.openPanel) · [Registrar uso manual](command:aiEcoMeter.logManual)`);
  statusItem.tooltip = md;
  statusItem.backgroundColor = pct >= 1 ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
  statusItem.show();
}

// ------------------------------------------------------------------ webviews

function getHtml(webview, mode) {
  const media = vscode.Uri.joinPath(ctx.extensionUri, 'media');
  const css = webview.asWebviewUri(vscode.Uri.joinPath(media, 'dashboard.css'));
  const js = webview.asWebviewUri(vscode.Uri.joinPath(media, 'dashboard.js'));
  const petsJs = webview.asWebviewUri(vscode.Uri.joinPath(media, 'pets.js'));
  const spritesJs = webview.asWebviewUri(vscode.Uri.joinPath(media, 'sprites.js'));
  const nonce = crypto.randomBytes(16).toString('base64');
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${css}" rel="stylesheet">
<title>Pegada da IA</title>
</head>
<body data-mode="${mode}">
<main id="app" class="app"><div class="loading"><div class="spinner"></div>Lendo seus logs de IA…</div></main>
<div id="tip" class="tooltip" role="tooltip"></div>
<script nonce="${nonce}" src="${spritesJs}"></script>
<script nonce="${nonce}" src="${petsJs}"></script>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
}

function attach(webview, mode, disposables) {
  webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(ctx.extensionUri, 'media')] };
  webview.html = getHtml(webview, mode);
  webviews.add(webview);
  disposables.push(
    webview.onDidReceiveMessage((msg) => {
      switch (msg && msg.type) {
        case 'ready':
          if (latest) webview.postMessage({ type: 'snapshot', snapshot: latest });
          else refresh();
          break;
        case 'refresh':
          refresh();
          break;
        case 'logManual':
          vscode.commands.executeCommand('aiEcoMeter.logManual');
          break;
        case 'openSettings':
          vscode.commands.executeCommand('aiEcoMeter.openSettings');
          break;
        case 'openPanel':
          vscode.commands.executeCommand('aiEcoMeter.openPanel');
          break;
      }
    }),
  );
}

class ViewProvider {
  /** @param {'sidebar'|'yard'} mode */
  constructor(mode) {
    this.mode = mode;
  }

  resolveWebviewView(view) {
    const disposables = [];
    attach(view.webview, this.mode, disposables);
    view.onDidDispose(() => {
      webviews.delete(view.webview);
      disposables.forEach((d) => d.dispose());
    });
  }
}

function openPanel() {
  if (panel) {
    panel.reveal();
    return;
  }
  panel = vscode.window.createWebviewPanel('aiEcoMeter.panel', 'Pegada da IA', vscode.ViewColumn.Active, {
    enableScripts: true,
    retainContextWhenHidden: true,
  });
  panel.iconPath = vscode.Uri.joinPath(ctx.extensionUri, 'media', 'panel-icon.svg');
  const disposables = [];
  attach(panel.webview, 'panel', disposables);
  panel.onDidDispose(() => {
    webviews.delete(panel.webview);
    disposables.forEach((d) => d.dispose());
    panel = null;
  });
}

// ------------------------------------------------------------------ registro manual

async function logManual() {
  const preset = await vscode.window.showQuickPick(PRESETS, {
    title: 'Registrar uso de IA (1/3) — que tipo de uso?',
    placeHolder: 'Para ferramentas que não deixam log local',
  });
  if (!preset) return;

  let inTok = preset.inTok || 0;
  let outTok = preset.outTok || 0;
  if (preset.custom) {
    const toInt = (v) => parseInt(String(v).replace(/\D/g, ''), 10);
    const a = await vscode.window.showInputBox({ title: 'Tokens de entrada (seu texto + contexto)', value: '1000', validateInput: (v) => (toInt(v) >= 0 ? null : 'Número inválido') });
    if (a === undefined) return;
    const b = await vscode.window.showInputBox({ title: 'Tokens de saída (resposta da IA)', value: '800', validateInput: (v) => (toInt(v) >= 0 ? null : 'Número inválido') });
    if (b === undefined) return;
    inTok = toInt(a);
    outTok = toInt(b);
  }

  const tool = await vscode.window.showQuickPick(TOOLS, { title: 'Registrar uso de IA (2/3) — qual ferramenta?' });
  if (!tool) return;

  const countStr = await vscode.window.showInputBox({
    title: 'Registrar uso de IA (3/3) — quantas vezes?',
    value: '1',
    validateInput: (v) => (/^\d+$/.test(v.trim()) && +v > 0 && +v <= 10000 ? null : 'Informe um número entre 1 e 10000'),
  });
  if (!countStr) return;
  const count = parseInt(countStr, 10);

  const entry = {
    ts: Date.now(),
    source: 'manual',
    model: tool,
    inTok: inTok * count,
    outTok: outTok * count,
    crTok: 0,
    cwTok: 0,
    requests: count,
  };
  if (preset.whFixed != null) entry.whFixed = preset.whFixed * count;
  const official = preset.perPrompt && OFFICIAL[tool];
  if (official) {
    entry.whFixed = official.wh * count;
    entry.mlFixed = official.ml * count;
    entry.official = official.ref;
  }
  await ctx.globalState.update(MANUAL_KEY, [...manualEntries(), entry]);
  await refresh();
  vscode.window.showInformationMessage(
    `Registrado: ${count}× ${tool}` + (official ? ` (valor oficial: ${official.wh} Wh por pergunta, ${official.ref}).` : '.') + ' Obrigado por acompanhar sua pegada!',
  );
}

async function clearManual() {
  const n = manualEntries().length;
  if (!n) {
    vscode.window.showInformationMessage('Não há registros manuais.');
    return;
  }
  const ok = await vscode.window.showWarningMessage(`Apagar ${n} registro(s) manual(is)?`, { modal: true }, 'Apagar');
  if (ok !== 'Apagar') return;
  await ctx.globalState.update(MANUAL_KEY, []);
  refresh();
}

// ------------------------------------------------------------------ ciclo de vida

function schedule() {
  if (timer) clearInterval(timer);
  timer = setInterval(refresh, readCfg().refreshSeconds * 1000);
}

function activate(context) {
  ctx = context;
  collector = new Collector();
  editorPets = new EditorPets();

  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  statusItem.command = 'aiEcoMeter.openPanel';
  statusItem.name = 'AI Eco Meter';
  statusItem.text = '$(globe) $(sync~spin)';
  statusItem.show();

  context.subscriptions.push(
    statusItem,
    editorPets,
    vscode.window.registerWebviewViewProvider('aiEcoMeter.dashboard', new ViewProvider('sidebar'), {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.registerWebviewViewProvider('aiEcoMeter.yardPanel', new ViewProvider('yard')),
    vscode.window.registerWebviewViewProvider('aiEcoMeter.yardExplorer', new ViewProvider('yard')),
    vscode.commands.registerCommand('aiEcoMeter.openPanel', openPanel),
    vscode.commands.registerCommand('aiEcoMeter.refresh', refresh),
    vscode.commands.registerCommand('aiEcoMeter.logManual', logManual),
    vscode.commands.registerCommand('aiEcoMeter.clearManual', clearManual),
    vscode.commands.registerCommand('aiEcoMeter.togglePets', () => {
      const c = vscode.workspace.getConfiguration('aiEcoMeter');
      return c.update('pets.enabled', !c.get('pets.enabled', true), vscode.ConfigurationTarget.Global);
    }),
    vscode.commands.registerCommand('aiEcoMeter.openSettings', () =>
      vscode.commands.executeCommand('workbench.action.openSettings', '@ext:pmxtecnologia.ai-eco-meter'),
    ),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('aiEcoMeter')) {
        schedule();
        refresh();
      }
    }),
    { dispose: () => timer && clearInterval(timer) },
  );

  schedule();
  refresh();
}

function deactivate() {}

module.exports = { activate, deactivate };
