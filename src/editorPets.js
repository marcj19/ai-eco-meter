'use strict';
// Bichinhos no editor: um SVG animado preso logo depois do texto da última linha visível.
// A API do VS Code não permite desenhar livremente sobre o editor; usamos uma decoração
// `after` com CSS extra (via `textDecoration`), o mesmo truque de extensões como a Power Mode.

const vscode = require('vscode');
const { W, H, PETS, EMOTES, toSvg, framesFor } = require('../media/sprites');

const S = 2; // escala do pixel no editor (bem discreto)
const STRIP_W = 420;
const STRIP_H = 36;
const RESTING = new Set(['capivara']); // quem fica só relaxando

function stripSvg(ids, mood) {
  const sw = W * S;
  const sh = H * S;
  const base = STRIP_H - sh;
  const range = STRIP_W - sw;
  const n = ids.length;
  const blink = (cls, dur) => `.${cls}{animation:blink ${dur}s ease-in-out infinite}`;
  let css =
    '.fa{animation:fa .44s step-end infinite}.fb{animation:fb .44s step-end infinite}' +
    '@keyframes fa{0%{opacity:1}50%{opacity:0}}@keyframes fb{0%{opacity:0}50%{opacity:1}}' +
    '@keyframes blink{0%,100%{opacity:0}30%,70%{opacity:1}}' +
    blink('zz', 2.6) + blink('em', 3.2);
  let body = '';
  let firstWalker = true;

  ids.forEach((id, i) => {
    const def = PETS[id];
    if (!def) return;
    const fr = framesFor(def, S);
    if (RESTING.has(id)) {
      const x = Math.round(((i + 0.5) / n) * range);
      const zzz = toSvg(EMOTES.zzz.rows, EMOTES.zzz.pal, S);
      const heart = mood === 'radiant' ? `<g class="em" transform="translate(${x + 4} ${base - 12})">${toSvg(EMOTES.heart.rows, EMOTES.heart.pal, S)}</g>` : '';
      body += `<g transform="translate(${x} ${base})">${fr.sleep}</g><g class="zz" transform="translate(${x + sw - 8} ${base - 8})">${zzz}</g>${heart}`;
      return;
    }
    const k = 'p' + i;
    const pxPerSec = def.speed * 1000 * (S / 3) * (mood === 'hot' ? 0.65 : 1);
    const dur = +((2 * range) / pxPerSec).toFixed(1);
    const delay = -((dur * i) / n).toFixed(1);
    css +=
      `@keyframes m${k}{0%{transform:translate(0px,${base}px)}50%{transform:translate(${range}px,${base}px)}100%{transform:translate(0px,${base}px)}}` +
      `.m${k}{animation:m${k} ${dur}s linear ${delay}s infinite}`;
    if (!def.sideways) {
      css +=
        `@keyframes f${k}{0%{transform:scaleX(1)}50%{transform:scaleX(-1)}}` +
        `.f${k}{animation:f${k} ${dur}s step-end ${delay}s infinite;transform-origin:${sw / 2}px ${sh / 2}px}`;
    }
    let emote = '';
    if (firstWalker && mood === 'hot') {
      emote = `<g class="em" transform="translate(${sw / 2 - 5} -12)">${toSvg(EMOTES.sweat.rows, EMOTES.sweat.pal, S)}</g>`;
    }
    firstWalker = false;
    body += `<g class="m${k}">${emote}<g class="f${k}"><g class="fa">${fr.A}</g><g class="fb">${fr.B}</g></g></g>`;
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${STRIP_W}" height="${STRIP_H}" viewBox="0 0 ${STRIP_W} ${STRIP_H}"><style>${css}</style>${body}</svg>`;
}

class EditorPets {
  constructor() {
    this.type = vscode.window.createTextEditorDecorationType({
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    });
    this.enabled = false;
    this.key = '';
    this.uri = null;
    this.lastTarget = '';
    this.timer = undefined;
    this.disposables = [
      this.type,
      vscode.window.onDidChangeActiveTextEditor(() => this.schedule(true)),
      vscode.window.onDidChangeTextEditorVisibleRanges((e) => {
        if (e.textEditor === vscode.window.activeTextEditor) this.schedule(false);
      }),
      vscode.workspace.onDidChangeTextDocument((e) => {
        const ed = vscode.window.activeTextEditor;
        if (ed && e.document === ed.document) this.schedule(false);
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('editor.fontSize') || e.affectsConfiguration('editor.lineHeight')) this.schedule(true);
      }),
    ];
  }

  /** @param {{enabled:boolean, list:string[]}} petCfg */
  update(petCfg, inEditor, mood) {
    const ids = (petCfg.list || []).filter((id) => PETS[id]).slice(0, 4);
    this.enabled = !!(petCfg.enabled && inEditor && ids.length);
    if (!this.enabled) {
      this.clearAll();
      return;
    }
    const key = ids.join(',') + '|' + mood;
    if (key !== this.key) {
      this.key = key;
      const svg = stripSvg(ids, mood);
      this.uri = vscode.Uri.parse('data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64'));
      this.schedule(true);
    }
  }

  schedule(force) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.render(force), 120);
  }

  lineHeight() {
    const c = vscode.workspace.getConfiguration('editor');
    const fontSize = c.get('fontSize', 14);
    const lh = c.get('lineHeight', 0);
    if (lh > 0) return lh < 8 ? Math.round(lh * fontSize) : lh;
    return Math.round(fontSize * (process.platform === 'darwin' ? 1.5 : 1.35));
  }

  render(force) {
    const ed = vscode.window.activeTextEditor;
    if (!this.enabled || !ed || !this.uri) return this.clearAll();
    for (const other of vscode.window.visibleTextEditors) if (other !== ed) other.setDecorations(this.type, []);

    const vr = ed.visibleRanges;
    if (!vr.length) return;
    const doc = ed.document;
    const lastVisible = vr[vr.length - 1].end.line;
    // a última linha costuma estar cortada pela borda do editor; usa a de cima
    const line = lastVisible >= doc.lineCount - 1 ? doc.lineCount - 1 : Math.max(vr[0].start.line, lastVisible - 1);
    const end = doc.lineAt(line).range.end;
    const target = `${doc.uri.toString()}#${line}:${end.character}`;
    if (!force && target === this.lastTarget) return; // evita reiniciar a animação à toa
    this.lastTarget = target;

    const top = this.lineHeight() - STRIP_H;
    ed.setDecorations(this.type, [
      {
        range: new vscode.Range(end, end),
        renderOptions: {
          after: {
            contentIconPath: this.uri,
            width: STRIP_W + 'px',
            height: STRIP_H + 'px',
            margin: '0 0 0 3ch',
            textDecoration: `none; position: absolute; top: ${top}px; pointer-events: none; z-index: 1;`,
          },
        },
      },
    ]);
  }

  clearAll() {
    this.lastTarget = '';
    for (const ed of vscode.window.visibleTextEditors) ed.setDecorations(this.type, []);
  }

  dispose() {
    clearTimeout(this.timer);
    this.disposables.forEach((d) => d.dispose());
  }
}

module.exports = { EditorPets, stripSvg };
