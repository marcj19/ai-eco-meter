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

// ---------------------------------------------------------------- Coletor

class Collector {
  constructor() {
    this.claudeFiles = new Map();
    this.codexFiles = new Map();
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

    return { records, sources };
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
