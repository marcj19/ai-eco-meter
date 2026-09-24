// @ts-check
(function () {
  'use strict';

  /* global acquireVsCodeApi */
  const vscode =
    typeof acquireVsCodeApi === 'function'
      ? acquireVsCodeApi()
      : { postMessage() {}, getState() { return null; }, setState() {} };

  const app = /** @type {HTMLElement} */ (document.getElementById('app'));
  const tipEl = /** @type {HTMLElement} */ (document.getElementById('tip'));
  const MODE = document.body.dataset.mode || 'panel';
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const saved = vscode.getState() || {};
  const state = {
    range: saved.range || 'today',
    metric: saved.metric || 'wh',
    snap: null,
    msgSeed: 0,
    tipIdx: 0,
  };
  let tipTimer = 0;

  const RANGES = { today: 'Hoje', week: '7 dias', month: '30 dias', all: 'Tudo' };
  const RANGE_CTX = { today: 'hoje', week: 'nos últimos 7 dias', month: 'nos últimos 30 dias', all: 'desde o início' };

  // ============================================================ formatação

  const nf = (v, d) => v.toLocaleString('pt-BR', { maximumFractionDigits: d, minimumFractionDigits: 0 });
  const dec = (v) => (v < 10 ? 2 : v < 100 ? 1 : 0);
  const F = {
    energy(wh) {
      if (wh >= 1e6) return nf(wh / 1e6, 2) + ' MWh';
      if (wh >= 1000) return nf(wh / 1000, 2) + ' kWh';
      return nf(wh, dec(wh)) + ' Wh';
    },
    water(ml) {
      if (ml >= 1e6) return nf(ml / 1e6, 2) + ' m³';
      if (ml >= 1000) return nf(ml / 1000, dec(ml / 1000)) + ' L';
      return nf(ml, ml < 10 ? 1 : 0) + ' mL';
    },
    co2(g) {
      if (g >= 1e6) return nf(g / 1e6, 2) + ' t';
      if (g >= 1000) return nf(g / 1000, dec(g / 1000)) + ' kg';
      return nf(g, g < 10 ? 1 : 0) + ' g';
    },
    tokens(n) {
      if (n >= 1e9) return nf(n / 1e9, 2) + ' bi';
      if (n >= 1e6) return nf(n / 1e6, 1) + ' mi';
      if (n >= 1e4) return nf(n / 1e3, 0) + ' mil';
      return nf(n, 0);
    },
    int: (n) => nf(n, 0),
    num: (n) => nf(n, dec(n)),
    pct: (p) => nf(p * 100, p < 0.1 ? 1 : 0) + '%',
    duration(sec) {
      if (sec < 60) return nf(sec, sec < 10 ? 1 : 0) + ' s';
      if (sec < 3600) return nf(sec / 60, sec < 600 ? 1 : 0) + ' min';
      if (sec < 86400 * 2) return nf(sec / 3600, 1) + ' h';
      if (sec < 86400 * 365) return nf(sec / 86400, 1) + ' dias';
      return nf(sec / 86400 / 365, 1) + ' anos';
    },
    distance(m) {
      return m >= 1000 ? nf(m / 1000, dec(m / 1000)) + ' km' : nf(m, 0) + ' m';
    },
  };

  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  function prettyModel(m) {
    const s = String(m || '').replace(/-\d{8}$/, '');
    if (/^claude-/i.test(s)) {
      const parts = s.split('-').slice(1);
      const name = [];
      const ver = [];
      for (const p of parts) (/^\d+$/.test(p) ? ver : name).push(p);
      return 'Claude ' + name.map((w) => w[0].toUpperCase() + w.slice(1)).join(' ') + (ver.length ? ' ' + ver.join('.') : '');
    }
    return s;
  }

  const SOURCE = {
    claude: { name: 'Claude Code', color: '#d97757' },
    codex: { name: 'Codex CLI', color: '#10a37f' },
    gemini: { name: 'Gemini CLI', color: '#4285f4' },
    antigravity: { name: 'Antigravity', color: '#a78bfa' },
    manual: { name: 'Registro manual', color: '#9aa7b4' },
  };

  // ============================================================ humor

  function moodOf(pct) {
    if (pct < 0.25) return 'radiant';
    if (pct < 0.6) return 'calm';
    if (pct < 1) return 'worried';
    return 'hot';
  }

  const MOOD_LABEL = { radiant: 'Radiante', calm: 'Tranquila', worried: 'Preocupada', hot: 'Com calor!' };
  const MESSAGES = {
    radiant: [
      'Tô fresquinha! Seu uso de IA está levinho hoje.',
      'Assim dá gosto: pouca energia, bastante resultado.',
      'Os ventos estão a favor, e as turbinas agradecem.',
      'Nem suei. Até as borboletas vieram passear.',
    ],
    calm: [
      'Tudo sob controle por aqui. Seguimos no equilíbrio.',
      'Ritmo bom! Pedidos objetivos ajudam a manter assim.',
      'Uso moderado, nada que um pouco de consciência não resolva.',
      'Tô de boa, mas de olho no termômetro.',
    ],
    worried: [
      'Hmm… está esquentando um pouquinho por aqui.',
      'Já passamos da metade da meta. Que tal agrupar pedidos?',
      'Contexto grande = mais energia. Uma sessão nova pode ajudar.',
      'Minhas geleiras pediram para eu te avisar…',
    ],
    hot: [
      'Ufa, tá quente! A meta diária de energia estourou.',
      'Meus oceanos estão suando. Que tal uma pausa?',
      'Meta estourada. Amanhã a gente compensa, combinado?',
      'Se eu tivesse um ventilador, ligava agora. Mas aí gastaria energia…',
    ],
  };

  // ============================================================ SVGs

  function sceneSvg(mood) {
    const sky = {
      radiant: ['#9fdcff', '#e6f7ff'],
      calm: ['#8fcfff', '#dff1ff'],
      worried: ['#ffcf9a', '#fff0da'],
      hot: ['#ff8a5c', '#ffd3a1'],
    }[mood];
    const hill = mood === 'hot' ? ['#c8b35a', '#a8a04a'] : mood === 'worried' ? ['#7fcf87', '#5fb870'] : ['#6fd49a', '#3fbf7f'];
    const spin = { radiant: '1.6s', calm: '3s', worried: '5s', hot: '9s' }[mood];
    const sunR = mood === 'hot' ? 20 : 15;
    const mouth = {
      radiant: '<path d="M147 101 Q160 118 173 101 Z" fill="#7a2230"/><path d="M152 106 Q160 112 168 106" fill="#ff8fa3"/>',
      calm: '<path d="M149 103 Q160 112 171 103" stroke="#1b1b2f" stroke-width="3" fill="none" stroke-linecap="round"/>',
      worried: '<path d="M150 108 Q160 102 170 108" stroke="#1b1b2f" stroke-width="3" fill="none" stroke-linecap="round"/>',
      hot: '<path d="M147 107 q3.25 -4 6.5 0 t6.5 0 t6.5 0 t6.5 0" stroke="#1b1b2f" stroke-width="3" fill="none" stroke-linecap="round"/><ellipse cx="160" cy="111" rx="4" ry="3" fill="#ff8fa3"/>',
    }[mood];
    const brows =
      mood === 'worried' || mood === 'hot'
        ? '<path d="M139 76 L151 71" stroke="#1b1b2f" stroke-width="2.5" stroke-linecap="round"/><path d="M181 76 L169 71" stroke="#1b1b2f" stroke-width="2.5" stroke-linecap="round"/>'
        : '';
    const pupilR = mood === 'hot' ? 2.6 : 3.6;

    let extras = '';
    if (mood === 'radiant' || mood === 'calm') {
      const wing = '<ellipse cx="-3.2" cy="-1" rx="3.4" ry="4.2"/><ellipse cx="-2.4" cy="3" rx="2.2" ry="2.6" opacity=".8"/>';
      const fly = (x, y, c, cls) =>
        `<g transform="translate(${x} ${y})"><g class="butterfly ${cls}" fill="${c}"><g class="wing">${wing}</g><g transform="scale(-1 1)"><g class="wing">${wing}</g></g><rect x="-.7" y="-4" width="1.4" height="9" rx=".7" fill="#4a3020"/></g></g>`;
      extras = fly(98, 60, '#ff9a3c', 'f1') + (mood === 'radiant' ? fly(206, 112, '#b58cff', 'f2') : '');
    }
    if (mood === 'worried' || mood === 'hot') {
      extras += '<path class="sweat" d="M203 66 q-5 8 0 11 q5 -3 0 -11z" fill="#7cc8ff"/>';
    }
    if (mood === 'hot') {
      extras += '<path class="sweat d2" d="M117 74 q-4 7 0 10 q4 -3 0 -10z" fill="#7cc8ff"/>';
      extras += ['h1', 'h2', 'h3']
        .map((c, i) => `<path class="heat-wave ${c}" d="M${134 + i * 26} 38 q4 -5 0 -10 t0 -10" stroke="#ff6b4a" stroke-width="2.5" fill="none" stroke-linecap="round"/>`)
        .join('');
      extras += `<g transform="translate(228 70)">
        <rect x="-5" y="-26" width="10" height="34" rx="5" fill="#fff" stroke="#1b1b2f" stroke-width="2"/>
        <rect class="thermo-fill" x="-2" y="-20" width="4" height="28" rx="2" fill="#ff3b3b"/>
        <circle cy="12" r="8" fill="#ff3b3b" stroke="#1b1b2f" stroke-width="2"/></g>`;
    }

    const continents = `
      <path d="M118 62c10-9 26-8 32 1 5 8-4 12-2 20 3 9 10 12 6 20-4 7-14 5-18-3-4-7-12-9-15-17-3-8-8-14-3-21z"/>
      <path d="M176 50c14-6 30-2 36 8 4 8-6 11-4 19 2 9 12 13 7 21-6 8-17 3-20-6-2-7-9-8-13-15-5-9-14-20-6-27z"/>
      <path d="M236 96c8-5 18-2 20 5 1 6-7 9-13 8-7-1-12-8-7-13z"/>
      <path d="M262 60c10-6 24-3 28 6 3 7-5 10-12 9-6 0-8 6-14 5-7-2-9-14-2-20z"/>
      <path d="M140 116c7-3 16-1 18 5 1 5-6 7-12 6-6-1-10-7-6-11z"/>`;

    const turbine = (x, hubY, baseY, s) => `
      <g>
        <path d="M${x - 2 * s} ${baseY} L${x - 0.8 * s} ${hubY} L${x + 0.8 * s} ${hubY} L${x + 2 * s} ${baseY}Z" fill="#f4f7fb" stroke="#b8c4d0" stroke-width="1"/>
        <g transform="translate(${x} ${hubY})"><g class="blades" style="--spin:${spin}">
          ${[0, 120, 240].map((a) => `<path transform="rotate(${a}) scale(${s})" d="M0 0 C2 -6 2 -16 0 -22 C-2 -16 -2 -6 0 0Z" fill="#ffffff" stroke="#b8c4d0" stroke-width="0.8"/>`).join('')}
          <circle r="${2.4 * s}" fill="#dfe6ee" stroke="#b8c4d0"/>
        </g></g>
      </g>`;

    return `<svg class="scene-svg" viewBox="0 0 320 180" role="img" aria-label="Planeta mascote: ${MOOD_LABEL[mood]}">
      <defs>
        <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${sky[0]}"/><stop offset="1" stop-color="${sky[1]}"/></linearGradient>
        <radialGradient id="ocean" cx=".35" cy=".3" r=".85"><stop offset="0" stop-color="#7fd6ff"/><stop offset=".7" stop-color="#2f8fe0"/><stop offset="1" stop-color="#1c6fc0"/></radialGradient>
        <radialGradient id="hotTint" cx=".5" cy=".5" r=".6"><stop offset="0" stop-color="#ff6b4a" stop-opacity="0"/><stop offset="1" stop-color="#ff6b4a" stop-opacity=".45"/></radialGradient>
        <clipPath id="globeClip"><circle cx="160" cy="88" r="46"/></clipPath>
      </defs>
      <rect width="320" height="180" fill="url(#sky)"/>
      <g transform="translate(276 40)">
        <g class="sun-rays">${Array.from({ length: 10 }, (_, i) => `<rect x="-2" y="${-sunR - 13}" width="4" height="8" rx="2" fill="#ffc933" transform="rotate(${i * 36})"/>`).join('')}</g>
        <circle class="sun-core" r="${sunR}" fill="#ffd34d" stroke="#ffb400" stroke-width="2"/>
      </g>
      <g class="cloud c1"><path d="M20 40a10 10 0 0 1 18-6 12 12 0 0 1 22 4 8 8 0 0 1 0 16H22a8 8 0 0 1-2-14z" fill="#fff" opacity=".9"/></g>
      <g class="cloud c2"><path d="M10 66a8 8 0 0 1 14-5 10 10 0 0 1 18 3 6 6 0 0 1 0 12H12a6 6 0 0 1-2-10z" fill="#fff" opacity=".75"/></g>
      ${mood !== 'hot' ? '<g class="bird"><path d="M10 26 q5 -5 10 0 q5 -5 10 0" stroke="#3b4a5e" stroke-width="1.8" fill="none" stroke-linecap="round"/></g>' : ''}
      <path d="M0 146 Q70 118 150 140 T320 128 V180 H0Z" fill="${hill[0]}"/>
      ${turbine(40, 104, 150, 1)}
      ${turbine(78, 120, 152, 0.7)}
      <g transform="translate(252 138)">
        <path d="M0 14 L8 0 H40 L32 14Z" fill="#2b4c7e" stroke="#9fb7d9" stroke-width="1"/>
        <path d="M8 7 H36 M16 0 L10 14 M24 0 L18 14 M32 0 L26 14" stroke="#9fb7d9" stroke-width=".8"/>
        <path d="M20 14 V22" stroke="#7a8796" stroke-width="2"/>
      </g>
      <path d="M0 158 Q90 144 170 158 T320 152 V180 H0Z" fill="${hill[1]}"/>
      <ellipse class="globe-shadow" cx="160" cy="160" rx="34" ry="5" fill="#000" opacity=".16"/>
      <g class="globe-float">
        <circle cx="160" cy="88" r="46" fill="url(#ocean)"/>
        <g clip-path="url(#globeClip)">
          <g class="continents" fill="#46c47e">${continents}<g transform="translate(200 0)">${continents}</g></g>
          <ellipse cx="160" cy="44" rx="26" ry="7" fill="#fff" opacity=".9"/>
          ${mood === 'hot' ? '<circle cx="160" cy="88" r="46" fill="url(#hotTint)"/>' : ''}
        </g>
        <path d="M130 64 a36 36 0 0 1 22 -14" stroke="#fff" stroke-width="4" stroke-linecap="round" opacity=".45" fill="none"/>
        <circle cx="160" cy="88" r="46" fill="none" stroke="#1b1b2f" stroke-opacity=".25" stroke-width="2"/>
        ${brows}
        <g class="eye"><ellipse cx="146" cy="84" rx="7.5" ry="8.5" fill="#fff"/></g>
        <g class="eye"><ellipse cx="174" cy="84" rx="7.5" ry="8.5" fill="#fff"/></g>
        <g class="pupils">
          <circle cx="147" cy="85" r="${pupilR}" fill="#1b1b2f"/><circle cx="175" cy="85" r="${pupilR}" fill="#1b1b2f"/>
          <circle cx="148.3" cy="83.3" r="1.2" fill="#fff"/><circle cx="176.3" cy="83.3" r="1.2" fill="#fff"/>
        </g>
        <ellipse cx="136" cy="98" rx="6" ry="3.5" fill="#ff7aa2" opacity="${mood === 'hot' ? 0.85 : 0.5}"/>
        <ellipse cx="184" cy="98" rx="6" ry="3.5" fill="#ff7aa2" opacity="${mood === 'hot' ? 0.85 : 0.5}"/>
        ${mouth}
        ${extras}
      </g>
    </svg>`;
  }

  function batterySvg(pct) {
    const p = Math.min(1, pct);
    const lvl = pct >= 1 ? 'lvl-high' : pct >= 0.6 ? 'lvl-mid' : 'lvl-low';
    const sparks =
      pct >= 1
        ? `<path class="spark k1" d="M14 30 L4 22"/><path class="spark k2" d="M86 44 L97 38"/><path class="spark k3" d="M84 100 L96 106"/>`
        : '';
    return `<svg viewBox="0 0 100 140" class="${lvl}" aria-hidden="true">
      <defs><clipPath id="batClip"><rect x="22" y="24" width="56" height="104" rx="8"/></clipPath></defs>
      <rect x="38" y="9" width="24" height="10" rx="3" class="bat-cap"/>
      <g clip-path="url(#batClip)">
        <g class="bat-level" style="--ty:${(1 - p) * 104}px">
          <rect x="22" y="24" width="56" height="110" class="bat-fill"/>
          <rect x="28" y="24" width="8" height="110" class="bat-shine"/>
        </g>
      </g>
      <rect x="18" y="20" width="64" height="112" rx="12" class="bat-body"/>
      <path class="bolt" d="M56 46 L38 80 H50 L44 108 L64 70 H52 Z"/>
      ${sparks}
    </svg>`;
  }

  function glassSvg(pct) {
    const p = Math.min(1, pct);
    const ty = 22 + (1 - p) * 110;
    const waves = (cls, dy) =>
      `<path class="wave ${cls}" d="M0 ${dy} ${Array.from({ length: 6 }, () => 'q12.5 -6 25 0 t25 0').join(' ')} V160 H0Z"/>`;
    const drips = pct >= 1 ? '<path class="drip r1" d="M82 26 q-4 6 0 9 q4 -3 0 -9z"/><path class="drip r2" d="M18 30 q-4 6 0 9 q4 -3 0 -9z"/>' : '';
    return `<svg viewBox="0 0 100 140" aria-hidden="true">
      <defs><clipPath id="glassClip"><path d="M24 22 L32 128 Q33 132 38 132 H62 Q67 132 68 128 L76 22Z"/></clipPath></defs>
      <path class="glass-outline" d="M22 18 L30 128 Q31 135 38 135 H62 Q69 135 70 128 L78 18"/>
      <g clip-path="url(#glassClip)">
        <g class="water-level" style="--ty:${ty}px">
          ${waves('w2', 2)}${waves('w1', 4)}
          <circle class="bubble-dot b1" cx="42" cy="0" r="2.5"/><circle class="bubble-dot b2" cx="55" cy="0" r="1.8"/><circle class="bubble-dot b3" cx="48" cy="0" r="2"/>
        </g>
      </g>
      <path class="glass-shine" d="M31 34 L36 110"/>
      ${drips}
    </svg>`;
  }

  const KPI_ICON = {
    tokens: '<path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18"/>',
    req: '<path d="M7 7h11l-3-3M17 17H6l3 3"/>',
    avg: '<path d="M5 19 19 5M7 6.5h.01M17 17.5h.01"/><circle cx="7" cy="7" r="2"/><circle cx="17" cy="17" r="2"/>',
    day: '<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M9 3v4M15 3v4"/>',
    co2: '<path d="M7 18a4 4 0 0 1-.5-8 6 6 0 0 1 11.5 1.5A3.5 3.5 0 0 1 17.5 18z"/>',
    clock: '<circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/>',
  };
  const kpiIcon = (k, color) =>
    `<svg viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${KPI_ICON[k]}</svg>`;

  const EQ_ICON = {
    phone: `<rect x="14" y="4" width="20" height="40" rx="4" fill="#2b3a55"/><rect x="17" y="9" width="14" height="29" rx="1.5" fill="#15202f"/>
      <rect class="ic-phone-fill" x="19" y="12" width="10" height="23" rx="1" fill="#3fbf7f"/>
      <path d="M25 15 L20.5 24 H24 L22.5 32 L28 22 H24.5Z" fill="#fff"/><rect x="21" y="40" width="6" height="1.6" rx=".8" fill="#6b7a90"/>`,
    bulb: `<circle class="ic-bulb-glow" cx="24" cy="19" r="15" fill="#ffd34d" opacity=".55"/>
      <path d="M24 6a12 12 0 0 1 7 21.7V32H17v-4.3A12 12 0 0 1 24 6z" fill="#ffe27a" stroke="#c9a227" stroke-width="1.5"/>
      <path d="M20 26 q2 -6 4 0 q2 -6 4 0" stroke="#c98a10" stroke-width="1.5" fill="none"/>
      <rect x="18" y="33" width="12" height="3.5" rx="1.5" fill="#9aa7b4"/><rect x="19" y="37.5" width="10" height="3.5" rx="1.5" fill="#7a8796"/>`,
    tv: `<rect x="4" y="8" width="40" height="27" rx="4" fill="#2b3a55"/><rect class="ic-tv-screen" x="7.5" y="11.5" width="33" height="20" rx="2" fill="#3ba8f5"/>
      <path d="M21 16.5 L29 21.5 L21 26.5Z" fill="#fff"/><path d="M18 40 H30 M24 35 V40" stroke="#6b7a90" stroke-width="2.5" stroke-linecap="round"/>`,
    microwave: `<rect x="3" y="10" width="42" height="28" rx="4" fill="#d5dce4" stroke="#9aa7b4" stroke-width="1.2"/>
      <rect x="7" y="14" width="26" height="20" rx="2" fill="#2b3a55"/>
      <circle class="ic-kernel p1" cx="15" cy="27" r="2.6" fill="#fff3c4"/><circle class="ic-kernel p2" cx="20" cy="26" r="3" fill="#fff3c4"/><circle class="ic-kernel p3" cx="25" cy="27.5" r="2.4" fill="#fff3c4"/>
      <ellipse cx="20" cy="31" rx="9" ry="1.6" fill="#9aa7b4"/>
      <circle cx="39" cy="18" r="2" fill="#7a8796"/><circle cx="39" cy="24" r="2" fill="#7a8796"/><rect x="36.5" y="29" width="5" height="2" rx="1" fill="#3fbf7f"/>`,
    glass: `<defs><clipPath id="icg"><path d="M14 8 L18 42 H30 L34 8Z"/></clipPath></defs>
      <g clip-path="url(#icg)"><path class="ic-glass-wave" d="M0 18 q6.25 -3 12.5 0 t12.5 0 t12.5 0 t12.5 0 t12.5 0 t12.5 0 V48 H0Z" fill="#3ba8f5"/></g>
      <path d="M13 6 L17.5 43 H30.5 L35 6" fill="none" stroke="#9fb7d9" stroke-width="2" stroke-linejoin="round"/>`,
    shower: `<path d="M8 4 H22 V10" stroke="#7a8796" stroke-width="3" fill="none" stroke-linecap="round"/>
      <path d="M14 10 H30 L27 16 H17Z" fill="#9aa7b4"/>
      ${[18, 22, 26].map((x, i) => `<path class="ic-drop q${i + 1}" d="M${x} 20 v4" stroke="#3ba8f5" stroke-width="2" stroke-linecap="round"/><path class="ic-drop q${((i + 1) % 3) + 1}" d="M${x + 1} 28 v4" stroke="#3ba8f5" stroke-width="2" stroke-linecap="round"/>`).join('')}`,
    car: `<circle class="ic-puff f1" cx="5" cy="30" r="3" fill="#9aa7b4"/><circle class="ic-puff f2" cx="5" cy="30" r="3" fill="#9aa7b4"/>
      <g class="ic-car"><path d="M7 32 V26 L12 25 L17 18 H31 L37 25 L43 26.5 V32Z" fill="#ff6b4a"/>
      <path d="M19 20 H24 V25 H15.5Z M26 20 H30.5 L34.5 25 H26Z" fill="#cfe8ff"/></g>
      <g class="ic-wheel"><circle cx="15" cy="32" r="4.5" fill="#2b3a55"/><path d="M15 28.5 V35.5" stroke="#9aa7b4" stroke-width="1.5"/></g>
      <g class="ic-wheel"><circle cx="35" cy="32" r="4.5" fill="#2b3a55"/><path d="M35 28.5 V35.5" stroke="#9aa7b4" stroke-width="1.5"/></g>
      <path d="M2 38 H46" stroke="#9aa7b4" stroke-width="1.2" stroke-dasharray="4 3"/>`,
    tree: `<rect x="21.5" y="28" width="5" height="16" rx="1.5" fill="#8b5a2b"/>
      <g class="ic-tree"><circle cx="24" cy="16" r="11" fill="#3fbf7f"/><circle cx="16" cy="22" r="7" fill="#35a86e"/><circle cx="32" cy="22" r="7" fill="#35a86e"/><circle cx="21" cy="13" r="3" fill="#6fd49a"/></g>
      <path class="ic-leaf" d="M34 26 q4 -2 5 2 q-4 2 -5 -2z" fill="#6fd49a"/>`,
  };

  const BADGE_PX = {
    first: { pal: { b: '#3ba8f5', w: '#cfeaff' }, rows: ['...bb...', '...bb...', '..bbbb..', '.bbbbbb.', '.bwbbbb.', '.bwbbbb.', '..bbbb..', '........'] },
    hundred: { pal: { y: '#ffc933', Y: '#d99a00' }, rows: ['...yy...', '...yy...', 'yyyyyyyy', '.yyYYyy.', '..yyyy..', '.yyyyyy.', '.yy..yy.', 'Y......Y'] },
    million: { pal: { y: '#ffd34d', Y: '#c98a10' }, rows: ['..yyyy..', '.YYYYYY.', '..yyyy..', '.YYYYYY.', '..yyyy..', '.YYYYYY.', '..yyyy..', '........'] },
    cache: { pal: { g: '#3fbf7f', G: '#2a8a5a' }, rows: ['..gggg..', '.gGGGGg.', '.gggggg.', '.gGGGGg.', '.gggggg.', '.gGGGGg.', '..gggg..', '........'] },
    zen: { pal: { y: '#ffe27a' }, rows: ['..yyy...', '.yy.....', 'yy......', 'yy......', 'yy......', 'yy....y.', '.yy.yy..', '..yyy...'] },
    eco: { pal: { g: '#5cc97a', G: '#2f8a4a' }, rows: ['.....ggg', '...ggggg', '..gggGgg', '.ggGGggg', '.gGgggg.', '.Ggggg..', 'G.......', '........'] },
    streak: { pal: { r: '#ff5b3a', o: '#ff9a3c', y: '#ffd84d' }, rows: ['...r....', '..rr....', '..rro.r.', '.rrooor.', '.rroyor.', '.royyor.', '..ryyr..', '........'] },
    marathon: { pal: { y: '#ffd34d' }, rows: ['....yy..', '...yy...', '..yy....', '.yyyyy..', '...yy...', '..yy....', '.yy.....', 'y.......'] },
    owl: { pal: { n: '#8b5a2b', w: '#fff4e0', e: '#1b1b1b', y: '#ffb400' }, rows: ['.n....n.', '.nnnnnn.', 'nwwnnwwn', 'nwennwen', 'nwwnnwwn', '.nnyynn.', '.nnnnnn.', '..n..n..'] },
  };

  function badgeIcon(id) {
    const b = BADGE_PX[id];
    return b && window.EcoPets ? window.EcoPets.pixel(b.rows, b.pal, 4) : '';
  }

  // ============================================================ seções

  function hero(r, cfg) {
    const perDay = r.wh / r.budgetDays;
    const pct = perDay / cfg.dailyBudgetWh;
    const mood = moodOf(pct);
    const msgs = MESSAGES[mood];
    const msg = msgs[(state.msgSeed + new Date().getDate()) % msgs.length];
    const fact =
      state.range === 'today'
        ? `Hoje: <b>${F.energy(r.wh)}</b>, ${F.pct(pct)} da meta diária de ${F.energy(cfg.dailyBudgetWh)}.`
        : `Média de <b>${F.energy(perDay)}/dia</b> ${RANGE_CTX[state.range]}, ${F.pct(pct)} da meta diária.`;
    return `<section class="card hero mood-${mood}">
      ${sceneSvg(mood)}
      <div class="hero-body"><div class="bubble"><span class="mood-chip">${MOOD_LABEL[mood]}</span><br><span id="msg">${msg}</span><span class="fact">${fact}</span></div></div>
    </section>`;
  }

  function tabs() {
    return `<nav class="tabs" role="tablist">${Object.entries(RANGES)
      .map(([k, v]) => `<button role="tab" data-range="${k}" class="${k === state.range ? 'active' : ''}" aria-selected="${k === state.range}">${v}</button>`)
      .join('')}</nav>`;
  }

  function count(v, f) {
    return `<span class="count" data-v="${v}" data-f="${f}">${F[f](v)}</span>`;
  }

  function gauges(r, cfg) {
    const eBudget = cfg.dailyBudgetWh * r.budgetDays;
    const wBudget = eBudget * cfg.waterLPerKWh;
    const pe = r.wh / eBudget;
    const pw = r.ml / wBudget;
    const col = (p, base) => (p >= 1 ? 'var(--heat)' : p >= 0.6 ? 'var(--energy)' : base);
    return `<section class="gauges">
      <div class="card gauge energy">
        <div class="label">Energia</div>
        ${batterySvg(pe)}
        <div class="value">${count(r.wh, 'energy')}</div>
        <div class="sub">${F.pct(pe)} de ${F.energy(eBudget)}</div>
        <div class="meter"><span style="--w:${Math.min(100, pe * 100)}%;background:${col(pe, 'var(--leaf)')}"></span></div>
      </div>
      <div class="card gauge water">
        <div class="label">Água</div>
        ${glassSvg(pw)}
        <div class="value">${count(r.ml, 'water')}</div>
        <div class="sub">${F.pct(pw)} de ${F.water(wBudget)}</div>
        <div class="meter"><span style="--w:${Math.min(100, pw * 100)}%;background:${col(pw, 'var(--water)')}"></span></div>
      </div>
    </section>`;
  }

  function kpis(r, cfg) {
    const avgReq = r.requests ? r.tokens / r.requests : 0;
    const avgOut = r.requests ? r.tok.out / r.requests : 0;
    const days = Math.max(1, r.activeDays);
    const input = r.tok.in + r.tok.cr + r.tok.cw;
    const card = (icon, color, label, value, sub) =>
      `<div class="card kpi"><div class="k-label">${kpiIcon(icon, color)}${label}</div><div class="k-value">${value}</div><div class="k-sub">${sub}</div></div>`;
    return `<section class="kpis">
      ${card('tokens', 'var(--c-in)', 'Tokens', count(r.tokens, 'tokens'), `${F.tokens(input)} entrada · ${F.tokens(r.tok.out)} saída`)}
      ${card('req', 'var(--water)', 'Requisições', count(r.requests, 'int'), `em ${r.activeDays} dia${r.activeDays === 1 ? '' : 's'} ativo${r.activeDays === 1 ? '' : 's'}`)}
      ${card('avg', 'var(--energy)', 'Média por requisição', count(avgReq, 'tokens') + ' tk', `${F.tokens(avgOut)} tokens gerados`)}
      ${card('day', 'var(--leaf)', 'Média por dia ativo', count(r.tokens / days, 'tokens') + ' tk', `${F.energy(r.wh / days)} · ${F.water(r.ml / days)}`)}
      ${card('co2', 'var(--carbon)', 'CO₂ equivalente', count(r.g, 'co2'), `rede a ${F.int(cfg.co2gPerKWh)} g/kWh`)}
      ${card('clock', 'var(--c-cw)', 'Horário de pico', r.peakHour >= 0 ? `${r.peakHour}h–${(r.peakHour + 1) % 24}h` : '—', r.peakHour >= 0 ? `${F.int(r.hours[r.peakHour])} requisições` : 'sem dados')}
    </section>`;
  }

  function composition(r) {
    const cats = [
      ['in', 'Entrada', 'var(--c-in)'],
      ['cw', 'Cache (escrita)', 'var(--c-cw)'],
      ['cr', 'Cache (leitura)', 'var(--c-cr)'],
      ['out', 'Saída', 'var(--c-out)'],
    ];
    const bar = (vals, total) =>
      `<div class="stackbar">${cats
        .map(([k, , c]) => (vals[k] > 0 ? `<span style="--w:${(vals[k] / total) * 100}%;background:${c}"></span>` : ''))
        .join('')}${vals.other > 0 ? `<span style="--w:${(vals.other / total) * 100}%;background:var(--c-other)"></span>` : ''}</div>`;
    const tokTotal = r.tokens || 1;
    const whTotal = r.wh || 1;
    const t = r.tok;
    const e = r.en;
    let insight = '';
    if (t.cr > 0 && r.wh > 0) {
      insight = `<b>${F.pct(t.cr / tokTotal)}</b> dos tokens foram leituras de cache, mas elas respondem por só <b>${F.pct(e.cr / whTotal)}</b> da energia. Já o texto gerado (saída) é ${F.pct(t.out / tokTotal)} dos tokens e <b>${F.pct(e.out / whTotal)}</b> da energia: gerar é bem mais caro que ler.`;
    } else if (r.tokens > 0) {
      insight = `Gerar texto (saída) custa cerca de 10× mais energia por token do que ler a entrada. Respostas mais curtas e diretas economizam!`;
    }
    return `<section class="card">
      <h2>Para onde vai a energia</h2>
      <div class="row-label"><span>Tokens</span><span>${F.tokens(r.tokens)}</span></div>
      ${bar({ ...t, other: 0 }, tokTotal)}
      <div class="row-label"><span>Energia</span><span>${F.energy(r.wh)}</span></div>
      ${bar(e, whTotal)}
      <div class="legend">${cats.map(([, n, c]) => `<span><i style="background:${c}"></i>${n}</span>`).join('')}${e.other > 0 ? '<span><i style="background:var(--c-other)"></i>Valor fixo (oficial/imagem)</span>' : ''}</div>
      ${insight ? `<div class="insight">${insight}</div>` : ''}
    </section>`;
  }

  function equivalences(r) {
    const items = [
      ['phone', F.num(r.wh / 15), 'cargas completas de celular'],
      ['bulb', F.duration((r.wh / 10) * 3600), 'de lâmpada LED (10 W) acesa'],
      ['tv', F.duration((r.wh / 77) * 3600), 'de streaming de vídeo'],
      ['microwave', F.duration(r.wh * 3.6), 'de micro-ondas ligado (1.000 W)'],
      ['glass', F.num(r.ml / 250), 'copos d’água (250 mL)'],
      ['shower', F.duration(r.ml / 150), 'de chuveiro aberto (9 L/min)'],
      ['car', F.distance(r.g / 0.12), 'rodados de carro a gasolina'],
      ['tree', F.num(r.g / 60), 'dias de uma árvore absorvendo CO₂'],
    ];
    return `<section class="card">
      <h2>Isso equivale a…</h2>
      <div class="equivs">${items
        .map(
          ([ic, v, l], i) =>
            `<div class="card equiv" style="--i:${i}"><svg viewBox="0 0 48 48" aria-hidden="true">${EQ_ICON[ic]}</svg><div><div class="e-value">${v}</div><div class="e-label">${l}</div></div></div>`,
        )
        .join('')}</div>
    </section>`;
  }

  function chartPoints(s) {
    const wd = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
    const dayLabel = (p) => {
      const [, m, d] = p.key.split('-');
      return `${wd[new Date(p.ts).getDay()]} ${d}/${m}`;
    };
    if (state.range === 'today') return { pts: s.hourly.map((p) => ({ ...p, label: `${p.key}h–${(p.key + 1) % 24}h` })), daily: false };
    let arr = s.daily;
    if (state.range === 'week') arr = arr.slice(-7);
    else if (state.range === 'month') arr = arr.slice(-30);
    else {
      const first = arr.findIndex((p) => p.requests > 0);
      arr = arr.slice(Math.min(first < 0 ? 0 : first, arr.length - 14));
    }
    return { pts: arr.map((p) => ({ ...p, label: dayLabel(p) })), daily: true };
  }

  function chart(s) {
    const { pts, daily } = chartPoints(s);
    const m = state.metric;
    const val = (p) => (m === 'wh' ? p.wh : m === 'ml' ? p.ml : p.tokens);
    const fmt = m === 'wh' ? F.energy : m === 'ml' ? F.water : F.tokens;
    const color = m === 'wh' ? 'var(--energy)' : m === 'ml' ? 'var(--water)' : 'var(--c-in)';
    const budget = daily ? (m === 'wh' ? s.cfg.dailyBudgetWh : m === 'ml' ? s.cfg.dailyBudgetWh * s.cfg.waterLPerKWh : 0) : 0;
    const max = Math.max(1e-9, ...pts.map(val), budget * 1.08);
    const last = pts.length - 1;
    const bars = pts
      .map((p, i) => {
        const v = val(p);
        const cls = ['bar', daily && i === last ? 'today' : '', budget && v > budget ? 'over' : ''].join(' ');
        const tip = `<b>${esc(p.label)}</b><br>Energia: ${F.energy(p.wh)} · Água: ${F.water(p.ml)}<br>${F.tokens(p.tokens)} tokens · ${F.int(p.requests)} req.`;
        return `<div class="bar-wrap" data-tip="${esc(tip)}"><div class="${cls}" style="--h:${(v / max) * 100}%;--i:${i};--bar-c:${color}"></div></div>`;
      })
      .join('');
    const axis = daily
      ? [pts[0], pts[Math.floor(last / 2)], pts[last]].map((p) => `<span>${esc(p.label.split(' ')[1])}</span>`).join('')
      : '<span>0h</span><span>6h</span><span>12h</span><span>18h</span><span>23h</span>';
    const budgetLine = budget ? `<div class="budget-line" style="bottom:${(budget / max) * 100}%"><span>meta</span></div>` : '';
    return `<section class="card">
      <h2>${daily ? 'Histórico diário' : 'Hoje, hora a hora'}<span class="spacer"></span>
        <span class="seg">${[['wh', 'Energia'], ['ml', 'Água'], ['tk', 'Tokens']]
          .map(([k, n]) => `<button data-metric="${k}" class="${k === m ? 'active' : ''}">${n}</button>`)
          .join('')}</span></h2>
      <div class="chart"><div class="bars">${bars}${budgetLine}</div><div class="axis">${axis}</div></div>
    </section>`;
  }

  function models(r) {
    if (!r.models.length) return '';
    const top = r.models.slice(0, 6);
    const max = top[0].wh || 1;
    return `<section class="card">
      <h2>Por modelo</h2>
      <div class="models">${top
        .map((m) => {
          const src = SOURCE[m.source] || SOURCE.manual;
          return `<div class="model-row">
            <div class="m-top"><span class="m-name" title="${esc(m.model)}"><i class="src-dot" style="background:${src.color}"></i>${esc(prettyModel(m.model))}</span><span class="m-wh">${F.energy(m.wh)}</span></div>
            <div class="meter"><span style="--w:${(m.wh / max) * 100}%;background:${src.color}"></span></div>
            <div class="m-sub">${esc(src.name)} · ${F.int(m.requests)} req. · ${F.tokens(m.tokens)} tokens · ${F.water(m.wh * state.snap.cfg.waterLPerKWh)}</div>
          </div>`;
        })
        .join('')}</div>
    </section>`;
  }

  function tipsFor(r, cfg) {
    const tips = [];
    const inputish = r.tok.in + r.tok.cr + r.tok.cw;
    const avgCtx = r.requests ? inputish / r.requests : 0;
    if (avgCtx > 40000)
      tips.push(`Cada chamada carrega em média <b>${F.tokens(avgCtx)} tokens</b> de contexto. Começar uma sessão nova (ex.: <code>/clear</code>) ao trocar de assunto evita arrastar histórico desnecessário.`);
    const big = r.models.filter((m) => /opus|fable|gpt-5(?!.*mini)|o3|pro/i.test(m.model)).reduce((a, m) => a + m.wh, 0);
    if (r.wh > 0 && big / r.wh > 0.5)
      tips.push(`<b>${F.pct(big / r.wh)}</b> da energia veio de modelos grandes. Para tarefas simples (renomear, formatar, perguntas rápidas), um modelo menor resolve e gasta bem menos.`);
    if (inputish > 0 && r.tok.cr / inputish > 0.7)
      tips.push(`Ótimo reaproveitamento de cache (<b>${F.pct(r.tok.cr / inputish)}</b> da entrada)! Ler do cache custa uma fração da energia de reprocessar o contexto.`);
    if (r.peakHour >= 0 && (r.peakHour >= 23 || r.peakHour < 5))
      tips.push('Seu pico de uso é de madrugada. Descansar também é sustentável, para você e para o planeta.');
    tips.push(
      'Pedidos claros e específicos significam menos idas e voltas, e menos energia gasta..',
      'Agrupe várias perguntas pequenas em uma única mensagem em vez de mandar uma de cada vez.',
      'Evite colar arquivos inteiros quando só um trecho importa: menos tokens de entrada.',
      'Regenerar uma resposta repete todo o custo. Às vezes, ajustar o pedido rende mais.',
      'Nem toda busca precisa de IA: um <code>grep</code> ou a documentação oficial às vezes resolvem mais rápido.',
      'Peça respostas objetivas (“responda em 3 linhas”): a saída é a parte mais cara da geração.',
      'Data centers usam água para resfriar servidores, e a geração de energia também consome água.',
    );
    return tips;
  }

  function tipCard(r, cfg) {
    const tips = tipsFor(r, cfg);
    state.tipIdx %= tips.length;
    return `<section class="card">
      <h2>Dica consciente</h2>
      <div class="tip-card">
        <svg viewBox="0 0 48 48" aria-hidden="true">${EQ_ICON.bulb}</svg>
        <div style="flex:1;min-width:0">
          <div class="tip-text" id="tipText">${tips[state.tipIdx]}</div>
          <div class="tip-nav"><div class="dots">${tips.map((_, i) => `<i class="${i === state.tipIdx ? 'on' : ''}"></i>`).join('')}</div><span class="spacer" style="flex:1"></span><button class="btn" data-act="nextTip">Próxima ›</button></div>
        </div>
      </div>
    </section>`;
  }

  function achievements(s) {
    const earned = s.achievements.filter((a) => a.earned).length;
    return `<section class="card">
      <h2>Conquistas <span style="text-transform:none;letter-spacing:0;font-weight:400">${earned}/${s.achievements.length}</span></h2>
      <div class="badges">${s.achievements
        .map((a) => {
          const ring =
            !a.earned && a.progress > 0
              ? `<svg class="ring" viewBox="0 0 60 60"><circle cx="30" cy="30" r="28" stroke="var(--border)"/><circle cx="30" cy="30" r="28" stroke="var(--leaf)" stroke-dasharray="${a.progress * 176} 176" transform="rotate(-90 30 30)" stroke-linecap="round"/></svg>`
              : '';
          const pct = a.earned ? 'Conquistada!' : `${Math.round(a.progress * 100)}% concluído`;
          return `<div class="badge ${a.earned ? 'earned' : 'locked'}" data-tip="${esc(`<b>${a.title}</b><br>${a.desc}<br><i>${pct}</i>`)}"><div class="medal pixel">${ring}${badgeIcon(a.id)}</div><div class="b-title">${a.title}</div></div>`;
        })
        .join('')}</div>
    </section>`;
  }

  function sourcesList(s) {
    const row = (key, info, extra) => {
      const src = SOURCE[key];
      let st;
      if (!info || !info.enabled) st = 'desativado';
      else if (key === 'manual') st = info.requests ? `${F.int(info.requests)} registros` : 'nenhum registro';
      else if (key === 'antigravity') st = info.requests ? `${F.int(info.requests)} conversas · estimativa` : 'nenhuma conversa encontrada';
      else st = info.requests ? `${F.int(info.requests)} req. · ${F.int(info.files)} arquivos` : 'nenhum log encontrado';
      return `<div class="source ${!info || !info.enabled || !info.requests ? 'off' : ''}" ${extra || ''}><i class="src-dot" style="background:${src.color}"></i>${src.name}<span class="s-state">${st}</span></div>`;
    };
    return `<div class="sources">
      ${row('claude', s.sources.claude, s.sources.claude && s.sources.claude.path ? `title="${esc(s.sources.claude.path)}"` : '')}
      ${row('codex', s.sources.codex, s.sources.codex && s.sources.codex.path ? `title="${esc(s.sources.codex.path)}"` : '')}
      ${row('gemini', s.sources.gemini, s.sources.gemini && s.sources.gemini.path ? `title="${esc(s.sources.gemini.path)}"` : '')}
      ${row('antigravity', s.sources.antigravity, s.sources.antigravity && s.sources.antigravity.path ? `title="${esc(s.sources.antigravity.path)}"` : '')}
      ${row('manual', s.sources.manual)}
    </div>`;
  }

  function footer(s) {
    const c = s.cfg;
    const t = new Date(s.generatedAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    return `<section class="card">
      <h2>Fontes de dados</h2>
      ${sourcesList(s)}
      <div class="actions" style="margin-top:12px">
        <button class="btn primary" data-act="logManual">＋ Registrar uso manual</button>
        <button class="btn" data-act="refresh"><span class="spin">⟳</span> Atualizar</button>
        <button class="btn" data-act="openSettings">⚙ Ajustar estimativas</button>
        ${MODE === 'sidebar' ? '<button class="btn" data-act="openPanel">⤢ Painel completo</button>' : ''}
      </div>
    </section>
    <section class="card">
      <details class="method">
        <summary>Como calculamos?</summary>
        <p>Os números são <b>estimativas de ordem de grandeza</b>, não medições. Nenhum provedor publica o consumo exato por token, então usamos coeficientes baseados em estudos públicos e você pode ajustá-los nas configurações.</p>
        <ul>
          <li>Saída: <code>${nf(c.whPer1kOutput, 3)} Wh</code> por 1.000 tokens · Entrada: <code>${nf(c.whPer1kInput, 3)}</code> · Cache (escrita): <code>${nf(c.whPer1kCacheWrite, 3)}</code> · Cache (leitura): <code>${nf(c.whPer1kCacheRead, 3)}</code></li>
          <li>Fator por modelo: ${Object.entries(c.modelMultipliers || {}).map(([k, v]) => `${esc(k)} ×${nf(Number(v), 2)}`).join(', ')}</li>
          <li>Água: <code>${nf(c.waterLPerKWh, 2)} L/kWh</code> (resfriamento + geração de energia) · CO₂: <code>${F.int(c.co2gPerKWh)} g/kWh</code></li>
        </ul>
        <p>Referências: Google (2025) mediu ~0,24 Wh e ~0,26 mL de água por prompt mediano do Gemini; a Epoch AI (2025) estimou ~0,3 Wh por consulta típica ao GPT-4o; a análise de ciclo de vida da Mistral (2025) aponta ~45 mL de água e ~1,1 g CO₂e para uma resposta de 400 tokens, incluindo o treino. Uso agêntico (ferramentas como o Claude Code) envolve contextos enormes a cada chamada, por isso o consumo sobe rápido.</p>
        <p><b>Tokens</b> do Claude Code, Codex CLI e Gemini CLI são <b>reais</b>, lidos dos logs de cada ferramenta. O <b>Antigravity</b> grava as conversas criptografadas: ali usamos uma <b>estimativa aproximada</b> pelo tamanho de cada conversa (~4 bytes por token, ~20% de texto gerado). Provavelmente fica abaixo do real, porque o agente reenvia o contexto a cada passo.</p>
        <p>Nos <b>registros manuais</b> de ChatGPT e Gemini (perguntas rápidas e respostas longas), usamos os valores por pergunta divulgados pelas próprias empresas: ChatGPT ≈ 0,34 Wh e 0,32 mL (OpenAI, 2025); Gemini ≈ 0,24 Wh e 0,26 mL (Google, 2025).</p>
        <p>Nenhum dado sai do seu computador: tudo é lido dos logs locais.</p>
      </details>
    </section>
    <div class="updated">Atualizado às ${t}</div>`;
  }

  function emptyView(s) {
    return `<section class="card empty">
      <svg viewBox="0 0 200 150" aria-hidden="true">
        <ellipse class="globe-shadow" cx="100" cy="138" rx="36" ry="5" fill="#000" opacity=".15"/>
        <g class="globe-float">
          <circle cx="100" cy="76" r="48" fill="#2f8fe0"/>
          <path d="M62 60c10-9 26-8 32 1 5 8-4 12-2 20 3 9 10 12 6 20-4 7-14 5-18-3-4-7-12-9-15-17z M112 44c14-6 30-2 32 8 2 8-6 11-4 19-4 6-14 4-18-4-4-8-16-16-10-23z" fill="#46c47e"/>
          <path d="M80 74 q6 5 12 0 M108 74 q6 5 12 0" stroke="#1b1b2f" stroke-width="3" fill="none" stroke-linecap="round"/>
          <ellipse cx="100" cy="94" rx="5" ry="3.5" fill="#7a2230"/>
          <text x="146" y="36" font-size="16" font-weight="700" fill="var(--muted)" class="sparkle">z</text>
          <text x="160" y="22" font-size="12" font-weight="700" fill="var(--muted)" class="sparkle s2">z</text>
        </g>
      </svg>
      <h3>Ainda não encontrei uso de IA por aqui</h3>
      <p>Leio automaticamente os logs locais do <b>Claude Code</b>, <b>Codex CLI</b>, <b>Gemini CLI</b> e <b>Antigravity</b>. Usa ChatGPT, Copilot ou Gemini? Registre manualmente e acompanhe sua pegada.</p>
      <div class="actions">
        <button class="btn primary" data-act="logManual">＋ Registrar uso manual</button>
        <button class="btn" data-act="refresh"><span class="spin">⟳</span> Procurar de novo</button>
        <button class="btn" data-act="openSettings">⚙ Configurações</button>
      </div>
    </section>
    ${s ? `<section class="card"><h2>Fontes de dados</h2>${sourcesList(s)}</section>` : ''}`;
  }

  // ============================================================ render

  function render(intro) {
    const s = state.snap;
    if (MODE === 'yard') {
      app.innerHTML = '';
      updatePets(s);
      return;
    }
    app.classList.toggle('intro', !!intro && !reducedMotion);
    tipEl.classList.remove('show');
    clearInterval(tipTimer);
    if (!s || !s.hasData) {
      app.innerHTML = emptyView(s);
      updatePets(s);
      return;
    }
    const r = s.ranges[state.range];
    const cfg = s.cfg;
    if (MODE === 'panel') {
      app.innerHTML = `
        ${tabs()}
        <div class="grid-main">
          <div class="stack">${hero(r, cfg)}${gauges(r, cfg)}${tipCard(r, cfg)}</div>
          <div class="stack">${kpis(r, cfg)}${chart(s)}${composition(r)}</div>
        </div>
        ${equivalences(r)}
        <div class="grid-main">
          <div class="stack">${models(r)}${footer(s)}</div>
          <div class="stack">${achievements(s)}</div>
        </div>`;
    } else {
      app.innerHTML = [hero(r, cfg), tabs(), gauges(r, cfg), kpis(r, cfg), chart(s), equivalences(r), composition(r), models(r), tipCard(r, cfg), achievements(s), footer(s)].join('');
    }
    if (intro && !reducedMotion) countUp();
    updatePets(s);
    tipTimer = window.setInterval(() => nextTip(), 12000);
  }

  function updatePets(s) {
    if (!window.EcoPets) return;
    const petCfg = (s && s.cfg && s.cfg.pets) || { enabled: true, list: ['gato', 'capivara', 'pato'] };
    let mood = 'calm';
    const facts = [];
    if (s && s.hasData) {
      const t = s.ranges.today;
      mood = moodOf(t.wh / s.cfg.dailyBudgetWh);
      if (t.requests) {
        facts.push(
          `Hoje: ${F.energy(t.wh)} e ${F.water(t.ml)} de água.`,
          `Isso dá ${F.num(t.wh / 15)} cargas de celular.`,
          `${F.tokens(t.tokens)} tokens hoje. Haja conversa!`,
          `Já foi ${F.pct(t.wh / s.cfg.dailyBudgetWh)} da meta de hoje.`,
          `Dava pra ver ${F.duration((t.wh / 77) * 3600)} de vídeo com essa energia.`,
        );
      } else {
        facts.push('Nenhuma IA hoje ainda. Que paz.', 'Dia tranquilo por aqui.');
      }
      if (mood === 'hot') facts.push('Tá quente hoje, hein.', 'Bora dar uma pausa?');
      if (mood === 'radiant') facts.push('Dia leve. Gostei.');
    }
    window.EcoPets.update({ enabled: petCfg.enabled, list: petCfg.list, mood, facts });
  }

  function countUp() {
    const els = app.querySelectorAll('.count');
    const t0 = performance.now();
    const dur = 1100;
    const step = (now) => {
      const k = Math.min(1, (now - t0) / dur);
      const e = 1 - Math.pow(1 - k, 3);
      els.forEach((el) => {
        const h = /** @type {HTMLElement} */ (el);
        const f = F[h.dataset.f || 'num'];
        h.textContent = f(Number(h.dataset.v) * e);
      });
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  function nextTip() {
    const s = state.snap;
    const el = document.getElementById('tipText');
    if (!s || !el) return;
    const tips = tipsFor(s.ranges[state.range], s.cfg);
    state.tipIdx = (state.tipIdx + 1) % tips.length;
    el.classList.add('fade');
    setTimeout(() => {
      el.innerHTML = tips[state.tipIdx];
      el.classList.remove('fade');
      app.querySelectorAll('.dots i').forEach((d, i) => d.classList.toggle('on', i === state.tipIdx));
    }, 250);
  }

  function save() {
    vscode.setState({ range: state.range, metric: state.metric });
  }

  // ============================================================ eventos

  app.addEventListener('click', (ev) => {
    const target = /** @type {HTMLElement} */ (ev.target);
    const rangeBtn = target.closest('[data-range]');
    if (rangeBtn) {
      state.range = /** @type {HTMLElement} */ (rangeBtn).dataset.range || 'today';
      save();
      render(true);
      return;
    }
    const metricBtn = target.closest('[data-metric]');
    if (metricBtn) {
      state.metric = /** @type {HTMLElement} */ (metricBtn).dataset.metric || 'wh';
      save();
      const old = app.querySelector('.chart');
      const sec = old && old.closest('section');
      if (sec && state.snap) {
        const tmp = document.createElement('div');
        tmp.innerHTML = chart(state.snap);
        sec.replaceWith(/** @type {Node} */ (tmp.firstElementChild));
      }
      return;
    }
    const scene = target.closest('.scene-svg');
    if (scene && state.snap) {
      state.msgSeed++;
      const r = state.snap.ranges[state.range];
      const mood = moodOf(r.wh / r.budgetDays / state.snap.cfg.dailyBudgetWh);
      const msgs = MESSAGES[mood];
      const el = document.getElementById('msg');
      if (el) el.textContent = msgs[(state.msgSeed + new Date().getDate()) % msgs.length];
      scene.classList.remove('poke');
      void (/** @type {SVGElement} */ (scene).getBoundingClientRect());
      scene.classList.add('poke');
      return;
    }
    const act = target.closest('[data-act]');
    if (act) {
      const a = /** @type {HTMLElement} */ (act).dataset.act;
      if (a === 'nextTip') {
        nextTip();
        clearInterval(tipTimer);
        tipTimer = window.setInterval(() => nextTip(), 12000);
        return;
      }
      if (a === 'refresh') act.classList.add('loading');
      vscode.postMessage({ type: a });
    }
  });

  // tooltip
  app.addEventListener('mousemove', (ev) => {
    const t = /** @type {HTMLElement} */ (ev.target).closest('[data-tip]');
    const html = t && /** @type {HTMLElement} */ (t).dataset.tip;
    if (!html || !html.includes('<')) {
      tipEl.classList.remove('show');
      return;
    }
    tipEl.innerHTML = html;
    tipEl.classList.add('show');
    const w = tipEl.offsetWidth;
    const h = tipEl.offsetHeight;
    let x = ev.clientX + 12;
    let y = ev.clientY - h - 10;
    if (x + w > window.innerWidth - 6) x = ev.clientX - w - 12;
    if (x < 6) x = 6;
    if (y < 6) y = ev.clientY + 16;
    tipEl.style.left = x + 'px';
    tipEl.style.top = y + 'px';
  });
  app.addEventListener('mouseleave', () => tipEl.classList.remove('show'));
  window.addEventListener('scroll', () => tipEl.classList.remove('show'), { passive: true });

  window.addEventListener('message', (ev) => {
    const msg = ev.data;
    if (msg && msg.type === 'snapshot') {
      const first = !state.snap;
      state.snap = msg.snapshot;
      render(first);
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
