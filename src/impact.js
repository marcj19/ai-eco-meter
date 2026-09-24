'use strict';
// Converte tokens em estimativas de energia (Wh), água (mL) e CO₂ (g) e agrega tudo
// no "snapshot" que o painel desenha.

const DAY = 24 * 60 * 60 * 1000;

const DEFAULT_MULTIPLIERS = { haiku: 0.35, nano: 0.2, mini: 0.35, flash: 0.35, sonnet: 1, opus: 2, fable: 3 };

function modelFactor(model, multipliers) {
  const m = String(model || '').toLowerCase();
  for (const [k, f] of Object.entries(multipliers || DEFAULT_MULTIPLIERS)) {
    if (k && m.includes(k.toLowerCase())) return Number(f) > 0 ? Number(f) : 1;
  }
  return 1;
}

/** Energia por categoria (Wh) de um registro. */
function recordEnergy(r, cfg) {
  if (r.whFixed != null) return { in: 0, out: 0, cr: 0, cw: 0, other: r.whFixed };
  const f = modelFactor(r.model, cfg.modelMultipliers);
  return {
    in: (r.inTok / 1000) * cfg.whPer1kInput * f,
    out: (r.outTok / 1000) * cfg.whPer1kOutput * f,
    cr: (r.crTok / 1000) * cfg.whPer1kCacheRead * f,
    cw: (r.cwTok / 1000) * cfg.whPer1kCacheWrite * f,
    other: 0,
  };
}

function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function addDays(ts, n) {
  const d = new Date(ts);
  d.setDate(d.getDate() + n);
  return d.getTime();
}

function dayKey(ts) {
  const d = new Date(ts);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function newAcc() {
  return {
    requests: 0,
    tok: { in: 0, out: 0, cr: 0, cw: 0 },
    en: { in: 0, out: 0, cr: 0, cw: 0, other: 0 },
    wh: 0,
    days: new Set(),
    hours: new Array(24).fill(0),
    models: new Map(),
    sources: new Map(),
    first: Infinity,
  };
}

function addTo(acc, r, e, wh) {
  const req = r.requests || 1;
  acc.requests += req;
  acc.tok.in += r.inTok;
  acc.tok.out += r.outTok;
  acc.tok.cr += r.crTok;
  acc.tok.cw += r.cwTok;
  for (const k in e) acc.en[k] += e[k];
  acc.wh += wh;
  acc.days.add(dayKey(r.ts));
  acc.hours[new Date(r.ts).getHours()] += req;
  acc.first = Math.min(acc.first, r.ts);
  const tokens = r.inTok + r.outTok + r.crTok + r.cwTok;
  const m = acc.models.get(r.model) || { model: r.model, source: r.source, requests: 0, tokens: 0, wh: 0 };
  m.requests += req;
  m.tokens += tokens;
  m.wh += wh;
  acc.models.set(r.model, m);
  const s = acc.sources.get(r.source) || { source: r.source, requests: 0, wh: 0 };
  s.requests += req;
  s.wh += wh;
  acc.sources.set(r.source, s);
}

function finish(acc, cfg, budgetDays) {
  const tokens = acc.tok.in + acc.tok.out + acc.tok.cr + acc.tok.cw;
  let peak = -1;
  let peakVal = 0;
  acc.hours.forEach((v, h) => {
    if (v > peakVal) {
      peakVal = v;
      peak = h;
    }
  });
  return {
    requests: acc.requests,
    tokens,
    tok: acc.tok,
    en: acc.en,
    wh: acc.wh,
    ml: acc.wh * cfg.waterLPerKWh, // Wh × L/kWh = mL
    g: (acc.wh / 1000) * cfg.co2gPerKWh,
    activeDays: acc.days.size,
    budgetDays,
    peakHour: peak,
    hours: acc.hours,
    models: [...acc.models.values()].sort((a, b) => b.wh - a.wh),
    sources: [...acc.sources.values()].sort((a, b) => b.wh - a.wh),
  };
}

function point(label, key) {
  return { key, label, requests: 0, tokens: 0, wh: 0 };
}

function buildSnapshot(records, sources, cfg, now = Date.now()) {
  const today0 = startOfDay(now);
  const bounds = { today: today0, week: addDays(today0, -6), month: addDays(today0, -29), all: -Infinity };
  const accs = { today: newAcc(), week: newAcc(), month: newAcc(), all: newAcc() };

  const dailyAll = new Map();
  const hourly = Array.from({ length: 24 }, (_, h) => point(h + 'h', h));

  for (const r of records) {
    if (!r.ts || r.ts > now + DAY) continue;
    const e = recordEnergy(r, cfg);
    const wh = e.in + e.out + e.cr + e.cw + e.other;
    const tokens = r.inTok + r.outTok + r.crTok + r.cwTok;
    for (const k of Object.keys(bounds)) if (r.ts >= bounds[k]) addTo(accs[k], r, e, wh);

    const dk = dayKey(r.ts);
    const d = dailyAll.get(dk) || point(dk, dk);
    d.requests += r.requests || 1;
    d.tokens += tokens;
    d.wh += wh;
    dailyAll.set(dk, d);

    if (r.ts >= today0) {
      const p = hourly[new Date(r.ts).getHours()];
      p.requests += r.requests || 1;
      p.tokens += tokens;
      p.wh += wh;
    }
  }

  const firstTs = accs.all.first === Infinity ? today0 : startOfDay(accs.all.first);
  const spanDays = Math.max(1, Math.round((today0 - firstTs) / DAY) + 1);

  // série diária dos últimos 90 dias (preenchendo dias vazios)
  const daily = [];
  for (let i = 89; i >= 0; i--) {
    const ts = addDays(today0, -i);
    const k = dayKey(ts);
    const p = dailyAll.get(k) || point(k, k);
    daily.push({ ...p, ts });
  }

  const ranges = {
    today: finish(accs.today, cfg, 1),
    week: finish(accs.week, cfg, 7),
    month: finish(accs.month, cfg, 30),
    all: finish(accs.all, cfg, spanDays),
  };

  for (const arr of [daily, hourly]) {
    for (const p of arr) {
      p.ml = p.wh * cfg.waterLPerKWh;
      p.g = (p.wh / 1000) * cfg.co2gPerKWh;
    }
  }

  return {
    generatedAt: now,
    hasData: accs.all.requests > 0,
    cfg: {
      dailyBudgetWh: cfg.dailyBudgetWh,
      waterLPerKWh: cfg.waterLPerKWh,
      co2gPerKWh: cfg.co2gPerKWh,
      whPer1kInput: cfg.whPer1kInput,
      whPer1kOutput: cfg.whPer1kOutput,
      whPer1kCacheRead: cfg.whPer1kCacheRead,
      whPer1kCacheWrite: cfg.whPer1kCacheWrite,
      modelMultipliers: cfg.modelMultipliers,
      pets: cfg.pets || { enabled: true, list: ['gato', 'capivara', 'pato'] },
    },
    sources,
    ranges,
    daily,
    hourly,
    achievements: achievements(ranges, [...dailyAll.values()], records, cfg),
  };
}

function achievements(ranges, days, records, cfg) {
  const all = ranges.all;
  const budget = cfg.dailyBudgetWh;
  const inputish = all.tok.in + all.tok.cr + all.tok.cw;
  const cacheShare = inputish ? all.tok.cr / inputish : 0;

  const keys = new Set(days.filter((d) => d.requests > 0).map((d) => d.key));
  let best = 0;
  for (const k of keys) {
    const prev = new Date(k + 'T12:00:00');
    prev.setDate(prev.getDate() - 1);
    if (keys.has(dayKey(prev.getTime()))) continue; // não é início de sequência
    let len = 0;
    const cur = new Date(k + 'T12:00:00');
    while (keys.has(dayKey(cur.getTime()))) {
      len++;
      cur.setDate(cur.getDate() + 1);
    }
    best = Math.max(best, len);
  }

  const zenDay = days.some((d) => d.requests >= 10 && d.wh <= budget * 0.25);
  const nightOwl = records.some((r) => {
    const h = new Date(r.ts).getHours();
    return h >= 0 && h < 5;
  });
  const maxReqDay = days.reduce((m, d) => Math.max(m, d.requests), 0);
  const weekAvg = ranges.week.wh / 7;

  const list = [
    { id: 'first', title: 'Primeira gota', desc: 'Fez a primeira requisição registrada', earned: all.requests > 0, progress: Math.min(1, all.requests) },
    { id: 'hundred', title: 'Centena', desc: '100 requisições no total', earned: all.requests >= 100, progress: Math.min(1, all.requests / 100) },
    { id: 'million', title: 'Milionário de tokens', desc: '1 milhão de tokens processados', earned: all.tokens >= 1e6, progress: Math.min(1, all.tokens / 1e6) },
    { id: 'cache', title: 'Mestre do cache', desc: '70%+ da entrada reaproveitada do cache', earned: cacheShare >= 0.7, progress: Math.min(1, cacheShare / 0.7) },
    { id: 'zen', title: 'Dia zen', desc: 'Um dia com 10+ requisições e até 25% da meta', earned: zenDay, progress: zenDay ? 1 : 0 },
    { id: 'eco', title: 'Semana verde', desc: 'Média dos últimos 7 dias abaixo de 50% da meta', earned: ranges.week.requests > 0 && weekAvg <= budget * 0.5, progress: ranges.week.requests > 0 ? Math.min(1, (budget * 0.5) / Math.max(weekAvg, 1e-9)) : 0 },
    { id: 'streak', title: 'Constância', desc: '7 dias seguidos usando IA', earned: best >= 7, progress: Math.min(1, best / 7) },
    { id: 'marathon', title: 'Maratona', desc: '200+ requisições em um único dia', earned: maxReqDay >= 200, progress: Math.min(1, maxReqDay / 200) },
    { id: 'owl', title: 'Coruja', desc: 'Usou IA entre meia-noite e 5h (vá dormir!)', earned: nightOwl, progress: nightOwl ? 1 : 0 },
  ];
  return list;
}

module.exports = { buildSnapshot, modelFactor, recordEnergy, DEFAULT_MULTIPLIERS };
