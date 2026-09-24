'use strict';
// Lê o uso de IA a partir dos logs locais das ferramentas (sem depender da API do VS Code,
// para poder ser testado com Node puro). Leitura incremental: cada arquivo .jsonl só é
// relido a partir do último byte processado.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');

const CHUNK = 8 * 1024 * 1024;
const EMPTY = Buffer.alloc(0);

async function listFiles(dir, depth, exts, out = []) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (depth > 0) await listFiles(p, depth - 1, exts, out);
    } else if (e.isFile() && exts.some((x) => e.name.endsWith(x))) {
      out.push(p);
    }
  }
  return out;
}

async function listJsonl(dir, depth = 5, out = []) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (depth > 0) await listJsonl(p, depth - 1, out);
    } else if (e.isFile() && e.name.endsWith('.jsonl')) {
      out.push(p);
    }
  }
  return out;
}

/** Lê apenas as linhas novas de `file` desde `st.offset`. Retorna false se nada mudou. */
async function readNewLines(file, st, onLine, onReset) {
  let stat;
  try {
    stat = await fsp.stat(file);
  } catch {
    return false;
  }
  if (stat.size < st.offset) {
    // arquivo foi reescrito/truncado: recomeça do zero
    st.offset = 0;
    st.leftover = EMPTY;
    onReset();
  }
  if (stat.size === st.offset) return false;

  const fh = await fsp.open(file, 'r');
  try {
    while (st.offset < stat.size) {
      const len = Math.min(CHUNK, stat.size - st.offset);
      const buf = Buffer.allocUnsafe(len);
      const { bytesRead } = await fh.read(buf, 0, len, st.offset);
      if (!bytesRead) break;
      const lineStart = st.offset - st.leftover.length;
      st.offset += bytesRead;
      const data = st.leftover.length
        ? Buffer.concat([st.leftover, buf.subarray(0, bytesRead)])
        : buf.subarray(0, bytesRead);
      const lastNl = data.lastIndexOf(10);
      if (lastNl < 0) {
        st.leftover = Buffer.from(data);
        continue;
      }
      st.leftover = Buffer.from(data.subarray(lastNl + 1));
      const text = data.toString('utf8', 0, lastNl);
      let pos = lineStart;
      for (const line of text.split('\n')) {
        if (line.length > 1) onLine(line, pos);
        pos += Buffer.byteLength(line) + 1;
      }
    }
  } finally {
    await fh.close();
  }
  return true;
}

// ---------------------------------------------------------------- Claude Code

function parseClaudeLine(line, st, file, pos) {
  if (line.indexOf('"usage"') === -1) return;
  let o;
  try {
    o = JSON.parse(line);
  } catch {
    return;
  }
  const m = o && o.message;
  if (!o || o.type !== 'assistant' || !m || !m.usage) return;
  if (!m.model || m.model === '<synthetic>') return;
  const u = m.usage;
  const rec = {
    ts: Date.parse(o.timestamp) || 0,
    source: 'claude',
    model: m.model,
    inTok: u.input_tokens || 0,
    outTok: u.output_tokens || 0,
    crTok: u.cache_read_input_tokens || 0,
    cwTok: u.cache_creation_input_tokens || 0,
    requests: 1,
  };
  // O Claude Code grava uma linha por bloco de conteúdo, repetindo o mesmo `usage`.
  const id = m.id ? m.id + '|' + (o.requestId || '') : file + ':' + pos;
  const prev = st.byId.get(id);
  if (!prev || rec.outTok >= prev.outTok) st.byId.set(id, rec);
}

// ---------------------------------------------------------------- Codex CLI

function parseCodexLine(line, st) {
  if (line.indexOf('token_count') === -1 && line.indexOf('turn_context') === -1) return;
  let o;
  try {
    o = JSON.parse(line);
  } catch {
    return;
  }
  const p = o && o.payload;
  if (!p) return;
  if (o.type === 'turn_context' && p.model) {
    st.model = p.model;
    return;
  }
  if (p.type !== 'token_count' || !p.info || !p.info.total_token_usage) return;
  // Usa o total acumulado da sessão (delta), imune a eventos repetidos.
  const t = p.info.total_token_usage;
  const cur = {
    input: t.input_tokens || 0,
    cached: t.cached_input_tokens || 0,
    output: t.output_tokens || 0,
  };
  const prev = st.prevTotal || { input: 0, cached: 0, output: 0 };
  const dIn = cur.input - prev.input;
  const dCached = cur.cached - prev.cached;
  const dOut = cur.output - prev.output;
  st.prevTotal = cur;
  if (dIn <= 0 && dOut <= 0) return;
  st.records.push({
    ts: Date.parse(o.timestamp) || 0,
    source: 'codex',
    model: st.model || 'codex',
    inTok: Math.max(0, dIn - Math.max(0, dCached)),
    outTok: Math.max(0, dOut),
    crTok: Math.max(0, dCached),
    cwTok: 0,
    requests: 1,
  });
}

// ---------------------------------------------------------------- Gemini CLI

function geminiRecord(o) {
  if (!o || o.type !== 'gemini' || !o.tokens || !o.id) return null;
  const t = o.tokens;
  const cached = t.cached || 0;
  return {
    ts: Date.parse(o.timestamp) || 0,
    source: 'gemini',
    model: o.model || 'gemini',
    inTok: Math.max(0, (t.input || 0) - cached), // `input` já inclui o que veio do cache
    outTok: (t.output || 0) + (t.thoughts || 0), // raciocínio também é texto gerado
    crTok: cached,
    cwTok: 0,
    requests: 1,
  };
}

function parseGeminiLine(line, st) {
  if (line.indexOf('"tokens"') === -1) return;
  let o;
  try {
    o = JSON.parse(line);
  } catch {
    return;
  }
  const rec = geminiRecord(o);
  // a mesma resposta pode ser regravada (ex.: quando ganha toolCalls); vale a última
  if (rec) st.byId.set(o.id, rec);
}

// ---------------------------------------------------------------- Antigravity

// As conversas do Antigravity são gravadas criptografadas, então os tokens reais não
// podem ser lidos. Estimativa: o tamanho da conversa (~4 bytes por token), com ~20% de texto
// gerado pelo modelo e o resto entrada (arquivos, resultados de ferramentas). Provavelmente
// fica abaixo do real, porque o agente reenvia o contexto a cada passo.
const AG_BYTES_PER_TOKEN = 4;
const AG_OUTPUT_SHARE = 0.2;

async function antigravityConversation(file, base, prev) {
  const stat = await fsp.stat(file);
  if (prev && prev.size === stat.size && prev.mtimeMs === stat.mtimeMs) return prev;
  const id = path.basename(file, '.pb');
  // Data da conversa: arquivo mais recente em brain/<id> (artefatos do agente) >
  // última visualização nas anotações > data do próprio .pb (pode ser a de uma restauração).
  let ts = 0;
  for (const f of await listFiles(path.join(base, 'brain', id), 2, [''])) {
    try {
      ts = Math.max(ts, (await fsp.stat(f)).mtimeMs);
    } catch {
      // ignora
    }
  }
  if (!ts) {
    try {
      const ann = await fsp.readFile(path.join(base, 'annotations', id + '.pbtxt'), 'utf8');
      const m = /last_user_view_time:\{seconds:(\d+)/.exec(ann);
      if (m) ts = Number(m[1]) * 1000;
    } catch {
      // sem anotação
    }
  }
  if (!ts) ts = stat.mtimeMs;
  const tokens = Math.round(stat.size / AG_BYTES_PER_TOKEN);
  return {
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    rec: {
      ts,
      source: 'antigravity',
      model: 'Antigravity (estimado)',
      inTok: tokens - Math.round(tokens * AG_OUTPUT_SHARE),
      outTok: Math.round(tokens * AG_OUTPUT_SHARE),
      crTok: 0,
      cwTok: 0,
      requests: 1,
      estimated: true,
    },
  };
}

// ---------------------------------------------------------------- Coletor

class Collector {
  constructor() {
    this.claudeFiles = new Map();
    this.codexFiles = new Map();
    this.geminiFiles = new Map();
    this.geminiJson = new Map();
    this.agFiles = new Map();
  }

  static geminiHome() {
    return process.env.GEMINI_CLI_HOME ? path.join(process.env.GEMINI_CLI_HOME, '.gemini') : path.join(os.homedir(), '.gemini');
  }

  static defaultClaudeDir() {
    const base = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
    return path.join(base, 'projects');
  }

  static defaultCodexDir() {
    const base = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
    return path.join(base, 'sessions');
  }

  /**
   * @param {{claude:boolean, codex:boolean, claudePath?:string, codexPath?:string}} opts
   */
  async collect(opts) {
    const sources = {};
    const records = [];

    if (opts.claude) {
      const dir = opts.claudePath || Collector.defaultClaudeDir();
      const files = await listJsonl(dir);
      await this._sync(files, this.claudeFiles, () => ({ byId: new Map() }), (line, st, file, pos) =>
        parseClaudeLine(line, st, file, pos),
      (st) => st.byId.clear());
      // deduplica entre arquivos (sessões retomadas copiam o histórico)
      const merged = new Map();
      for (const st of this.claudeFiles.values()) {
        for (const [id, rec] of st.byId) {
          const prev = merged.get(id);
          if (!prev || rec.outTok >= prev.outTok) merged.set(id, rec);
        }
      }
      for (const r of merged.values()) records.push(r);
      sources.claude = { enabled: true, path: dir, files: files.length, requests: merged.size };
    } else {
      sources.claude = { enabled: false };
    }

    if (opts.codex) {
      const dir = opts.codexPath || Collector.defaultCodexDir();
      const files = await listJsonl(dir);
      await this._sync(files, this.codexFiles, () => ({ records: [], model: null, prevTotal: null }),
        (line, st) => parseCodexLine(line, st),
        (st) => { st.records = []; st.prevTotal = null; });
      let n = 0;
      for (const st of this.codexFiles.values()) {
        for (const r of st.records) records.push(r);
        n += st.records.length;
      }
      sources.codex = { enabled: true, path: dir, files: files.length, requests: n };
    } else {
      sources.codex = { enabled: false };
    }

    if (opts.gemini) {
      const dir = opts.geminiPath || path.join(Collector.geminiHome(), 'tmp');
      const all = await listFiles(dir, 3, ['.jsonl', '.json']);
      const chats = all.filter((f) => path.basename(path.dirname(f)) === 'chats');
      const jsonl = chats.filter((f) => f.endsWith('.jsonl'));
      await this._sync(jsonl, this.geminiFiles, () => ({ byId: new Map() }), (line, st) => parseGeminiLine(line, st),
        (st) => st.byId.clear());
      await this._syncGeminiJson(chats.filter((f) => f.endsWith('.json')));
      const merged = new Map();
      for (const st of [...this.geminiFiles.values(), ...this.geminiJson.values()]) {
        for (const [id, rec] of st.byId) merged.set(id, rec);
      }
      for (const r of merged.values()) records.push(r);
      sources.gemini = { enabled: true, path: dir, files: chats.length, requests: merged.size };
    } else {
      sources.gemini = { enabled: false };
    }

    if (opts.antigravity) {
      const base = opts.antigravityPath || path.join(Collector.geminiHome(), 'antigravity');
      const files = (await listFiles(path.join(base, 'conversations'), 0, ['.pb']));
      const alive = new Set(files);
      for (const f of this.agFiles.keys()) if (!alive.has(f)) this.agFiles.delete(f);
      for (const f of files) {
        try {
          this.agFiles.set(f, await antigravityConversation(f, base, this.agFiles.get(f)));
        } catch {
          // arquivo em uso: tenta na próxima rodada
        }
      }
      for (const c of this.agFiles.values()) records.push(c.rec);
      sources.antigravity = { enabled: true, path: base, files: files.length, requests: this.agFiles.size, estimated: true };
    } else {
      sources.antigravity = { enabled: false };
    }

    return { records, sources };
  }

  /** Versões antigas do Gemini CLI salvam a sessão inteira num .json reescrito a cada mensagem. */
  async _syncGeminiJson(files) {
    const alive = new Set(files);
    for (const f of this.geminiJson.keys()) if (!alive.has(f)) this.geminiJson.delete(f);
    for (const f of files) {
      try {
        const stat = await fsp.stat(f);
        const prev = this.geminiJson.get(f);
        if (prev && prev.size === stat.size && prev.mtimeMs === stat.mtimeMs) continue;
        const data = JSON.parse(await fsp.readFile(f, 'utf8'));
        const byId = new Map();
        for (const m of (data && data.messages) || []) {
          const rec = geminiRecord(m);
          if (rec) byId.set(m.id, rec);
        }
        this.geminiJson.set(f, { size: stat.size, mtimeMs: stat.mtimeMs, byId });
      } catch {
        // arquivo sendo gravado: tenta de novo depois
      }
    }
  }

  async _sync(files, map, init, parse, reset) {
    const alive = new Set(files);
    for (const f of map.keys()) if (!alive.has(f)) map.delete(f);
    for (const file of files) {
      let st = map.get(file);
      if (!st) {
        st = Object.assign({ offset: 0, leftover: EMPTY }, init());
        map.set(file, st);
      }
      try {
        await readNewLines(file, st, (line, pos) => parse(line, st, file, pos), () => reset(st));
      } catch {
        // arquivo em uso/ilegível: tenta de novo na próxima rodada
      }
    }
  }
}

module.exports = { Collector };
