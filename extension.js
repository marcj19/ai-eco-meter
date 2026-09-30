'use strict';
const vscode = require('vscode');
const crypto = require('crypto');
const { Collector } = require('./src/collector');
const { buildSnapshot, DEFAULT_MULTIPLIERS } = require('./src/impact');
const { EditorPets } = require('./src/editorPets');
const { GameHost } = require('./src/gameHost');
const I18n = require('./media/i18n');

const MANUAL_KEY = 'aiEcoMeter.manualEntries';
const ACHIEVEMENTS_KEY = 'aiEcoMeter.achievements';
const GAME_KEY = 'aiEcoMeter.game'; // só para migrar o progresso da 0.6.0
const VERSION_KEY = 'aiEcoMeter.lastVersion';

/**
 * Versões com destaque mostrado uma única vez depois de atualizar (texto em i18n: "news.<versão>").
 * Versões fora desta lista (correções pequenas) atualizam em silêncio. Se a pessoa pular versões,
 * vale o destaque mais recente.
 */
const WHATS_NEW = ['0.6.0', '0.7.0', '0.8.0'];

/**
 * Link de doação voluntária (ex.: https://paypal.me/seunome). Vazio = o botão "Apoiar o projeto"
 * e o comando ficam escondidos. Ao preencher, adicione também "sponsor": { "url": ... } no package.json.
 */
const SUPPORT_URL = 'https://www.paypal.com/donate/?business=paulomjunior7%40gmail.com';

function openSupport() {
  if (!SUPPORT_URL) return undefined;
  return vscode.env.openExternal(vscode.Uri.parse(SUPPORT_URL));
}

/** Presets para registrar uso de ferramentas sem log local. */
// Valores por pergunta divulgados pelas próprias empresas (média/mediana de um prompt de texto).
const OFFICIAL = {
  ChatGPT: { wh: 0.34, ml: 0.32, ref: 'OpenAI, 2025' },
  Gemini: { wh: 0.24, ml: 0.26, ref: 'Google, 2025' },
};

function presets() {
  const p = (icon, key, extra) => Object.assign({ label: `$(${icon}) ${t('manual.preset.' + key)}`, detail: t(`manual.preset.${key}.detail`) }, extra);
  return [
    p('comment', 'quick', { inTok: 200, outTok: 400, perPrompt: true }),
    p('code', 'long', { inTok: 1500, outTok: 1500, perPrompt: true }),
    p('file-text', 'doc', { inTok: 20000, outTok: 1500 }),
    p('search', 'agent', { inTok: 150000, outTok: 8000 }),
    p('file-media', 'image', { whFixed: 3 }),
    p('edit', 'custom', { custom: true }),
  ];
}

const tools = () => ['ChatGPT', 'GitHub Copilot', 'Gemini', 'Claude.ai', 'Cursor', 'Perplexity', t('manual.other')];

let collector;
let statusItem;
let timer;
let latest = null;
let running = null;
const webviews = new Set();
let panel = null;
let ctx;
let editorPets;
let game;
let gameTimer;
let lastGameView = null;
let pendingOffline = 0;
const yardViews = new Set();
const webviewModes = new Map(); // webview -> modo (para recarregar ao trocar de idioma)
let t = I18n.create('pt');

/** Idioma escolhido: configuração "aiEcoMeter.language" ou, em "auto", o idioma do VS Code. */
function resolveLang() {
  const setting = vscode.workspace.getConfiguration('aiEcoMeter').get('language', 'auto');
  return I18n.resolve(setting, vscode.env.language);
}

/** Aplica o idioma; se mudou, recarrega as abas abertas para trocar todos os textos. */
function applyLang() {
  const lang = resolveLang();
  if (lang === t.lang) return false;
  t = I18n.create(lang);
  if (game) game.setLang(lang);
  if (panel) panel.title = t('webview.title');
  for (const [w, mode] of webviewModes) {
    try {
      w.html = getHtml(w, mode);
    } catch {
      webviewModes.delete(w);
    }
  }
  return true;
}

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
    gameEnabled: c.get('game.enabled', true),
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
    latest.cfg.lang = t.lang;
    latest.cfg.support = !!SUPPORT_URL;
    await keepAchievements(latest.achievements);
    updateStatusBar(cfg);
    const pct = latest.ranges.today.wh / cfg.dailyBudgetWh;
    const mood = pct < 0.25 ? 'radiant' : pct < 0.6 ? 'calm' : pct < 1 ? 'worried' : 'hot';
    editorPets.update(cfg.pets, cfg.petsInEditor, mood);
    game.setMood(mood);
    game.setBasePets(cfg.pets.list);
    broadcast();
  })()
    .catch((err) => console.error('[AI Eco Meter]', err))
    .finally(() => {
      running = null;
    });
  return running;
}

/**
 * Conquistas são permanentes: uma vez ganha, fica registrada (com a data), mesmo que a
 * condição deixe de valer depois (ex.: "Semana verde" só olha os últimos 7 dias).
 */
async function keepAchievements(list) {
  const saved = ctx.globalState.get(ACHIEVEMENTS_KEY, null);
  const firstRun = saved === null;
  const map = Object.assign({}, saved || {});
  const fresh = [];
  for (const a of list) {
    if (a.earned && !map[a.id]) {
      map[a.id] = Date.now();
      fresh.push(a);
    }
    if (map[a.id]) {
      a.earned = true;
      a.progress = 1;
      a.earnedAt = map[a.id];
    }
  }
  if (fresh.length || firstRun) await ctx.globalState.update(ACHIEVEMENTS_KEY, map);
  // na primeira execução, as conquistas do histórico entram em silêncio
  if (!firstRun) {
    for (const a of fresh) {
      vscode.window
        .showInformationMessage(t('ach.unlocked', t(`ach.${a.id}.title`), t(`ach.${a.id}.desc`)), t('ach.view'))
        .then((pick) => pick && openPanel());
    }
  }
}

// ------------------------------------------------------------------ novidades

function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
}

function showChangelog() {
  const uri = vscode.Uri.joinPath(ctx.extensionUri, 'CHANGELOG.md');
  return vscode.commands.executeCommand('markdown.showPreview', uri).then(undefined, () => vscode.window.showTextDocument(uri));
}

/**
 * @param {boolean} existingUser havia dados de uma versão anterior (antes de gravarmos a versão)
 */
async function announceUpdate(existingUser) {
  const current = ctx.extension.packageJSON.version;
  // quem veio da 0.5.x não tem a versão gravada: trata como atualização, não como instalação nova
  const previous = ctx.globalState.get(VERSION_KEY) || (existingUser ? '0.5.0' : undefined);
  if (previous === current) return;
  await ctx.globalState.update(VERSION_KEY, current);

  if (!previous) {
    const pick = await vscode.window.showInformationMessage(t('news.welcome'), t('news.openPanel'), t('news.openYard'));
    if (pick === t('news.openPanel')) openPanel();
    else if (pick === t('news.openYard')) vscode.commands.executeCommand('aiEcoMeter.yardPanel.focus');
    return;
  }

  // destaque mais recente entre as versões novas desde a última usada
  const news = WHATS_NEW.filter((v) => compareVersions(v, previous) > 0 && compareVersions(v, current) <= 0).sort(compareVersions);
  if (!news.length) return;
  const pick = await vscode.window.showInformationMessage(
    t('news.updated', current, t('news.' + news[news.length - 1])),
    t('news.seeChanges'),
    t('news.openYard'),
  );
  if (pick === t('news.seeChanges')) showChangelog();
  else if (pick === t('news.openYard')) vscode.commands.executeCommand('aiEcoMeter.yardPanel.focus');
}

// ------------------------------------------------------------------ jogo

function sendGame(view) {
  if (!readCfg().gameEnabled || !view) return;
  if (view.offline) {
    pendingOffline += view.offline;
    view.offline = 0;
  }
  lastGameView = view;
  if (!yardViews.size) return; // guarda o aviso de progresso offline até alguém abrir a aba
  const msg = Object.assign({}, view, { offline: pendingOffline });
  pendingOffline = 0;
  for (const w of yardViews) {
    Promise.resolve()
      .then(() => w.postMessage({ type: 'game', game: msg }))
      .catch(() => yardViews.delete(w));
  }
}

function gameStep() {
  if (!readCfg().gameEnabled) return;
  try {
    sendGame(game.tick());
  } catch (err) {
    console.error('[AI Eco Meter] jogo:', err);
  }
}

function gameAction(action) {
  // na janela dona a ação vale na hora; nas outras, é repassada e aparece no próximo segundo
  if (game.action(action)) gameStep();
}

function startGame() {
  game = new GameHost(ctx.globalStorageUri.fsPath, ctx.globalState.get(GAME_KEY, null));
  game.setLang(t.lang);
  gameTimer = setInterval(gameStep, 1000);
}

function broadcast() {
  for (const w of webviews) {
    // uma webview pode ter sido fechada entre a coleta e o envio
    Promise.resolve()
      .then(() => w.postMessage({ type: 'snapshot', snapshot: latest }))
      .catch(() => webviews.delete(w));
  }
}

// ------------------------------------------------------------------ status bar

function fmt(n, d) {
  return n.toLocaleString(t.locale, { maximumFractionDigits: d, minimumFractionDigits: 0 });
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
  if (n >= 1e9) return fmt(n / 1e9, 1) + t('unit.billion');
  if (n >= 1e6) return fmt(n / 1e6, 1) + t('unit.million');
  if (n >= 1e3) return fmt(n / 1e3, 1) + t('unit.thousand');
  return fmt(n, 0);
}

function updateStatusBar(cfg) {
  if (!cfg.statusBar || !latest) {
    statusItem.hide();
    return;
  }
  const td = latest.ranges.today;
  const pct = td.wh / cfg.dailyBudgetWh;
  const mood = t('status.mood.' + (pct < 0.25 ? 'radiant' : pct < 0.6 ? 'calm' : pct < 1 ? 'worried' : 'hot'));
  statusItem.text = `$(globe) ${fmtEnergy(td.wh)} · ${fmtWater(td.ml)}`;
  const md = new vscode.MarkdownString(undefined, true);
  md.isTrusted = true;
  md.appendMarkdown(`${t('status.title', mood)}\n\n`);
  md.appendMarkdown(`| | |\n|---|---|\n`);
  md.appendMarkdown(`| ${t('status.energy')} | ${fmtEnergy(td.wh)} (${t('status.goal', fmt(pct * 100, 0))}) |\n`);
  md.appendMarkdown(`| ${t('status.water')} | ${fmtWater(td.ml)} |\n`);
  md.appendMarkdown(`| CO₂ | ${fmt(td.g, td.g < 10 ? 1 : 0)} g |\n`);
  md.appendMarkdown(`| ${t('status.tokens')} | ${t('status.tokensLine', fmtTokens(td.tokens), fmt(td.requests, 0))} |\n\n`);
  md.appendMarkdown(`[${t('status.openPanel')}](command:aiEcoMeter.openPanel) · [${t('status.logManual')}](command:aiEcoMeter.logManual)`);
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
  const gameJs = webview.asWebviewUri(vscode.Uri.joinPath(media, 'game.js'));
  const i18nJs = webview.asWebviewUri(vscode.Uri.joinPath(media, 'i18n.js'));
  const nonce = crypto.randomBytes(16).toString('base64');
  return `<!DOCTYPE html>
<html lang="${t.locale}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${css}" rel="stylesheet">
<title>${t('webview.title')}</title>
</head>
<body data-mode="${mode}" data-lang="${t.lang}">
<main id="app" class="app"><div class="loading"><div class="spinner"></div>${t('loading')}</div></main>
<div id="tip" class="tooltip" role="tooltip"></div>
<script nonce="${nonce}" src="${i18nJs}"></script>
<script nonce="${nonce}" src="${spritesJs}"></script>
<script nonce="${nonce}" src="${petsJs}"></script>
<script nonce="${nonce}" src="${js}"></script>
<script nonce="${nonce}" src="${gameJs}"></script>
</body>
</html>`;
}

function attach(webview, mode, disposables) {
  webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(ctx.extensionUri, 'media')] };
  webview.html = getHtml(webview, mode);
  webviews.add(webview);
  webviewModes.set(webview, mode);
  if (mode === 'yard') yardViews.add(webview);
  disposables.push(
    {
      dispose: () => {
        yardViews.delete(webview);
        webviewModes.delete(webview);
      },
    },
    webview.onDidReceiveMessage((msg) => {
      switch (msg && msg.type) {
        case 'ready':
          if (latest) webview.postMessage({ type: 'snapshot', snapshot: latest });
          else refresh();
          if (mode === 'yard' && lastGameView) sendGame(Object.assign({}, lastGameView, { events: [] }));
          break;
        case 'game:harvest':
          gameAction({ type: 'harvest', plot: Number(msg.plot), manual: !!msg.manual });
          break;
        case 'game:buy':
          gameAction({ type: 'buy', id: String(msg.id) });
          break;
        case 'game:claim':
          gameAction({ type: 'claim', index: Number(msg.index) });
          break;
        case 'game:pet':
          gameAction({ type: 'pet' });
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
        case 'support':
          openSupport();
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
    // guarda a referência: depois do dispose, acessar `view.webview` lança "Webview is disposed"
    const webview = view.webview;
    view.onDidDispose(() => {
      webviews.delete(webview);
      disposables.forEach((d) => d.dispose());
    });
  }
}

function openPanel() {
  if (panel) {
    panel.reveal();
    return;
  }
  panel = vscode.window.createWebviewPanel('aiEcoMeter.panel', t('webview.title'), vscode.ViewColumn.Active, {
    enableScripts: true,
    retainContextWhenHidden: true,
  });
  panel.iconPath = vscode.Uri.joinPath(ctx.extensionUri, 'media', 'panel-icon.svg');
  const disposables = [];
  attach(panel.webview, 'panel', disposables);
  const current = panel;
  const webview = current.webview;
  current.onDidDispose(() => {
    webviews.delete(webview);
    disposables.forEach((d) => d.dispose());
    if (panel === current) panel = null;
  });
}

// ------------------------------------------------------------------ registro manual

async function logManual() {
  const preset = await vscode.window.showQuickPick(presets(), {
    title: t('manual.step1'),
    placeHolder: t('manual.step1.hint'),
  });
  if (!preset) return;

  let inTok = preset.inTok || 0;
  let outTok = preset.outTok || 0;
  if (preset.custom) {
    const toInt = (v) => parseInt(String(v).replace(/\D/g, ''), 10);
    const a = await vscode.window.showInputBox({ title: t('manual.inTokens'), value: '1000', validateInput: (v) => (toInt(v) >= 0 ? null : t('manual.invalid')) });
    if (a === undefined) return;
    const b = await vscode.window.showInputBox({ title: t('manual.outTokens'), value: '800', validateInput: (v) => (toInt(v) >= 0 ? null : t('manual.invalid')) });
    if (b === undefined) return;
    inTok = toInt(a);
    outTok = toInt(b);
  }

  const tool = await vscode.window.showQuickPick(tools(), { title: t('manual.step2') });
  if (!tool) return;

  const countStr = await vscode.window.showInputBox({
    title: t('manual.step3'),
    value: '1',
    validateInput: (v) => (/^\d+$/.test(v.trim()) && +v > 0 && +v <= 10000 ? null : t('manual.countInvalid')),
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
  vscode.window.showInformationMessage(t('manual.done', count, tool, official));
}

async function clearManual() {
  const n = manualEntries().length;
  if (!n) {
    vscode.window.showInformationMessage(t('manual.none'));
    return;
  }
  const ok = await vscode.window.showWarningMessage(t('manual.confirmClear', n), { modal: true }, t('manual.clear'));
  if (ok !== t('manual.clear')) return;
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
  t = I18n.create(resolveLang());
  collector = new Collector();
  editorPets = new EditorPets();
  // verificado antes da primeira coleta, que já grava conquistas
  const existingUser = [ACHIEVEMENTS_KEY, MANUAL_KEY, GAME_KEY].some((k) => context.globalState.get(k) !== undefined);
  startGame();
  vscode.commands.executeCommand('setContext', 'aiEcoMeter.hasSupport', !!SUPPORT_URL);
  // deixa a janela terminar de carregar antes de mostrar a notificação
  setTimeout(() => announceUpdate(existingUser).catch(() => {}), 4000);

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
    vscode.commands.registerCommand('aiEcoMeter.showChangelog', showChangelog),
    vscode.commands.registerCommand('aiEcoMeter.support', openSupport),
    vscode.commands.registerCommand('aiEcoMeter.togglePets', () => {
      const c = vscode.workspace.getConfiguration('aiEcoMeter');
      return c.update('pets.enabled', !c.get('pets.enabled', true), vscode.ConfigurationTarget.Global);
    }),
    vscode.commands.registerCommand('aiEcoMeter.openSettings', () =>
      vscode.commands.executeCommand('workbench.action.openSettings', '@ext:pmxtecnologia.ai-eco-meter'),
    ),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('aiEcoMeter')) {
        applyLang();
        schedule();
        refresh();
      }
    }),
    { dispose: () => timer && clearInterval(timer) },
  );

  schedule();
  refresh();
}

function deactivate() {
  if (gameTimer) clearInterval(gameTimer);
  if (game) game.release();
}

module.exports = { activate, deactivate };
