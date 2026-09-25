// @ts-check
// "Quintal do planeta": desenha o jogo idle na aba Bichinhos. A lógica fica na extensão
// (src/game.js); aqui só desenhamos o estado recebido e mandamos as ações do jogador.
(function () {
  'use strict';

  if (document.body.dataset.mode !== 'yard') return;

  // a API do VS Code só pode ser obtida uma vez; o dashboard.js a compartilha
  const vscode = { postMessage: (m) => window.__vscodeApi && window.__vscodeApi.postMessage(m) };
  const { toSvg, framesFor, PETS } = window.EcoSprites;

  const PAL = {
    g: '#5cc97a', G: '#2f8a4a', s: '#8b5a2b', S: '#6b4220', r: '#ff4d5e', y: '#ffd84d',
    o: '#ff9a3c', b: '#7a4a1f', w: '#fff4e0', p: '#ff8fb8', P: '#e0609a',
  };
  const SOIL = ['.ssssssss.', 'sSssSssSss'];
  const EMPTY = '..........';
  const STAGES = {
    seed: [EMPTY, EMPTY, EMPTY, EMPTY, EMPTY, EMPTY, '....b.....'],
    sprout: [EMPTY, EMPTY, EMPTY, EMPTY, '....g.g...', '.....g....', '.....g....'],
    small: [EMPTY, EMPTY, EMPTY, '...g...g..', '....g.gg..', '...ggGg...', '.....g....'],
    big: [EMPTY, '..g.....g.', '..gg.g.gg.', '...ggGgg..', '..g.gGg.g.', '....gGg...', '.....G....'],
  };
  const RIPE = [
    [EMPTY, '..g.....g.', '.rgg.g.ggr', '.rrggGggrr', '..r.gGg.r.', '....gGg...', '.....G....'], // morango
    ['...g..g...', '..gg.gg...', '...gggg.g.', '..g.gGgg..', '....gGg...', '....ooo...', '....ooo...'], // cenoura
    ['...yyyy...', '..yybbyy..', '..ybbbby..', '..yybbyy..', '...yyyy...', '..g..G..g.', '...ggGgg..'], // girassol
  ];

  // Árvore típica de cada bioma (a que você planta ali)
  const TREES = {
    cerrado: {
      pal: { g: '#9bb24a', G: '#6f8a2c', b: '#6b4220' },
      rows: ['..gg...ggg..', '.gGgg.gggGg.', 'ggggggGgggg.', '.gg.gbgg.gg.', '....bb.b....', '...b..bb....', '.....bb.....', '.....b......', '....bbb.....'],
    },
    caatinga: {
      pal: { g: '#5a9e5a', G: '#3d7a3d' },
      rows: ['....g.......', '....gG......', '.g..gG......', '.gG.gG..g...', '.gGggG..gG..', '..ggggGggG..', '....gG.ggG..', '....gG......', '....gG......', '....gG......', '...ggGg.....'],
    },
    pantanal: {
      pal: { p: '#ff8fb8', P: '#e0609a', b: '#6b4220' },
      rows: ['...pppp.....', '.ppPppppp...', 'pppppPpppp..', '.pPppppPpp..', '..pppppp....', '....bb......', '....bb......', '....bb......', '...bbbb.....'],
    },
    mata: {
      pal: { g: '#4caf50', G: '#2e7d32', b: '#6b4220' },
      rows: ['....gggg....', '..gggGgggg..', '.gggggggGgg.', 'gggGgggggggg', 'ggggggGggggg', '.gggGggggGg.', '..gggggggg..', '....gggg....', '.....bb.....', '.....bb.....', '....bbbb....'],
    },
    amazonia: {
      pal: { g: '#2e8b57', G: '#1b5e3a', b: '#5a3a1a' },
      rows: ['.gggg..gggg.', 'gggGgggGgggg', 'ggggggggGggg', '.gGggggggGg.', '...gg..gg...', '.....bb.....', '.....bb.....', '.....bb.....', '.....bb.....', '....bbbb....', '...bb..bb...'],
    },
  };

  const SEED_ICON = ['.gg.gg.', 'gGg.gGg', '..gGg..', '...G...', '..sss..', '.sssss.'];
  const TREE_ICON = ['..ggg..', '.gGggg.', 'gggggGg', '.ggGgg.', '...b...', '...b...'];
  const CHEST_ICON = ['.bbbbbb.', 'byyyyyyb', 'bbbbbbbb', 'byybbyyb', 'byyyyyyb', 'bbbbbbbb'];

  const MOOD = {
    radiant: { label: 'Planeta radiante', cls: 'good' },
    calm: { label: 'Planeta tranquilo', cls: 'good' },
    worried: { label: 'Planeta preocupado', cls: 'mid' },
    hot: { label: 'Planeta com calor', cls: 'bad' },
  };

  function nf(n) {
    n = Math.floor(n);
    if (n >= 1e9) return (n / 1e9).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + ' bi';
    if (n >= 1e6) return (n / 1e6).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + ' mi';
    if (n >= 1e5) return Math.round(n / 1e3).toLocaleString('pt-BR') + ' mil';
    return n.toLocaleString('pt-BR');
  }
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  let state = null;
  let layer = null;
  let menuOpen = false;
  let tab = 'missoes';
  const plotEls = [];
  let lastPets = '';
  let treesKey = '';

  function stageOf(p, kind) {
    if (p >= 1) return 'ripe' + kind;
    if (p < 0.15) return 'seed';
    if (p < 0.45) return 'sprout';
    if (p < 0.8) return 'small';
    return 'big';
  }

  function plantSvg(stage) {
    const rows = stage.startsWith('ripe') ? RIPE[Number(stage.slice(4))] : STAGES[stage];
    return toSvg(rows.concat(SOIL), PAL, window.EcoPets.scale);
  }

  function ensureLayer() {
    const yard = window.EcoPets && window.EcoPets.yard();
    if (!yard) return null;
    if (layer && layer.parentElement === yard) return layer;
    layer = document.createElement('div');
    layer.className = 'game';
    layer.innerHTML = `
      <div class="game-trees"></div>
      <div class="game-plots"></div>
      <div class="game-hud">
        <span class="hud-item" title="Sementes">${toSvg(SEED_ICON, PAL, 2)}<b id="gSeeds">0</b><small id="gRate"></small></span>
        <button class="hud-item hud-biome" id="gBiome" title="Restaure o bioma plantando árvores">${toSvg(TREE_ICON, PAL, 2)}<span id="gBiomeName"></span><i class="mini-bar"><i id="gBiomeBar"></i></i></button>
        <span class="hud-mood" id="gMood"></span>
        <span class="spacer"></span>
        <button class="hud-btn" id="gMenuBtn">Menu<span class="menu-badge" id="gBadge" hidden></span></button>
      </div>
      <div class="game-menu" id="gMenu" hidden>
        <div class="menu-head">
          <nav class="menu-tabs">
            <button data-tab="missoes">Missões</button><button data-tab="loja">Loja</button><button data-tab="biomas">Biomas</button>
          </nav>
          <span class="menu-seeds">${toSvg(SEED_ICON, PAL, 2)} <b id="gMenuSeeds"></b></span>
          <button class="hud-btn" data-close>Fechar</button>
        </div>
        <div class="menu-body" id="gMenuBody"></div>
      </div>
      <div class="game-toast" id="gToast"></div>`;
    yard.appendChild(layer);
    layer.querySelector('#gMenuBtn').addEventListener('click', () => openMenu(menuOpen ? null : defaultTab()));
    layer.querySelector('#gBiome').addEventListener('click', () => openMenu('biomas'));
    plotEls.length = 0;
    treesKey = '';
    return layer;
  }

  function defaultTab() {
    return state && state.missions.some((m) => m.done && !m.claimed) ? 'missoes' : tab;
  }

  // ---------------------------------------------------------------- cenário

  function plotCenter(i, n) {
    return Math.round((layer.clientWidth * (i + 1)) / (n + 1));
  }

  function renderPlots() {
    const box = layer.querySelector('.game-plots');
    const n = state.plots.length;
    while (plotEls.length < n) {
      const el = document.createElement('div');
      el.className = 'plot';
      const idx = plotEls.length;
      el.addEventListener('click', () => {
        if (state && state.plots[idx] && state.plots[idx].p >= 1) vscode.postMessage({ type: 'game:harvest', plot: idx, manual: true });
      });
      box.appendChild(el);
      plotEls.push({ el, stage: '' });
    }
    const pw = 10 * window.EcoPets.scale;
    state.plots.forEach((plot, i) => {
      const item = plotEls[i];
      const stage = stageOf(plot.p, plot.kind);
      if (item.stage !== stage) {
        item.stage = stage;
        item.el.innerHTML = plantSvg(stage);
        item.el.classList.toggle('ripe', plot.p >= 1);
      }
      item.el.title = plot.p >= 1 ? 'Madura! Clique para colher (+25%)' : `Crescendo: ${Math.round(plot.p * 100)}%`;
      const cx = plotCenter(i, n);
      item.el.style.left = cx - pw / 2 + 'px';
      if (plot.p >= 1) window.EcoPets.request('plot' + i, cx);
    });
  }

  function renderScenery() {
    const yard = window.EcoPets.yard();
    const biome = state.biome.id;
    if (yard.dataset.biome !== biome) {
      yard.dataset.biome = biome;
      treesKey = '';
    }
    const shown = Math.min(state.trees, 24);
    const key = biome + ':' + shown;
    if (treesKey === key) return;
    treesKey = key;
    const box = layer.querySelector('.game-trees');
    box.innerHTML = '';
    const tree = TREES[biome] || TREES.mata;
    for (let i = 0; i < shown; i++) {
      const t = document.createElement('span');
      // espalha de forma determinística, alternando bordas e meio
      const pos = ((i * 37) % 100) / 100;
      t.style.left = `calc(${(3 + pos * 90).toFixed(1)}% - 12px)`;
      t.style.setProperty('--d', (i % 5) * 0.4 + 's');
      t.innerHTML = toSvg(tree.rows, tree.pal, i % 3 === 0 ? 3 : 2);
      box.appendChild(t);
    }
  }

  function floatText(x, text, cls) {
    const f = document.createElement('div');
    f.className = 'float ' + (cls || '');
    f.textContent = text;
    f.style.left = x + 'px';
    layer.appendChild(f);
    setTimeout(() => f.remove(), 1500);
  }

  function toast(html, big) {
    const t = /** @type {any} */ (layer.querySelector('#gToast'));
    t.innerHTML = html;
    t.classList.toggle('big', !!big);
    t.classList.add('show');
    clearTimeout(t._timer);
    t._timer = setTimeout(() => t.classList.remove('show'), big ? 9000 : 7000);
  }

  function confetti() {
    const colors = ['#5cc97a', '#ffd84d', '#ff8fb8', '#6cc4ff', '#ff9a3c'];
    for (let i = 0; i < 28; i++) {
      const c = document.createElement('i');
      c.className = 'leaf';
      c.style.left = Math.random() * 100 + '%';
      c.style.background = colors[i % colors.length];
      c.style.animationDelay = Math.random() * 0.8 + 's';
      c.style.setProperty('--dx', (Math.random() * 60 - 30).toFixed(0) + 'px');
      layer.appendChild(c);
      setTimeout(() => c.remove(), 3200);
    }
  }

  // ---------------------------------------------------------------- HUD

  function renderHud() {
    layer.querySelector('#gSeeds').textContent = nf(state.seeds);
    layer.querySelector('#gRate').textContent = `+${nf(state.rate * 60)}/min`;
    const b = state.biome;
    layer.querySelector('#gBiomeName').textContent = `${b.name}${b.lap > 1 ? ` (${b.lap}ª)` : ''} ${b.trees}/${b.need}`;
    /** @type {HTMLElement} */ (layer.querySelector('#gBiomeBar')).style.width = Math.min(100, (b.trees / b.need) * 100) + '%';
    const m = MOOD[state.mood] || MOOD.calm;
    const moodEl = layer.querySelector('#gMood');
    const eff = state.moodSpeed >= 1 ? `+${Math.round((state.moodSpeed - 1) * 100)}%` : `−${Math.round((1 - state.moodSpeed) * 100)}%`;
    moodEl.textContent = `${m.label}: ${eff}`;
    moodEl.className = 'hud-mood ' + m.cls;
    /** @type {HTMLElement} */ (moodEl).title = 'O ritmo da colheita acompanha o seu uso de IA hoje: dia leve rende mais, dia pesado deixa os bichinhos com calor.';
    const claimable = state.missions.filter((x) => x.done && !x.claimed).length;
    const badge = /** @type {HTMLElement} */ (layer.querySelector('#gBadge'));
    badge.hidden = !claimable;
    badge.textContent = String(claimable);
    layer.querySelector('#gMenuBtn').classList.toggle('pulse', !!claimable || state.shop.some((it) => it.affordable && !it.maxed));
  }

  // ---------------------------------------------------------------- menu

  function openMenu(which) {
    menuOpen = !!which;
    if (which) tab = which;
    renderMenu(true);
  }

  /**
   * Atualiza o menu no lugar (sem recriar tudo a cada segundo), para não perder a rolagem
   * nem interromper um arrasto.
   */
  function renderMenu(force) {
    const el = /** @type {HTMLElement} */ (layer.querySelector('#gMenu'));
    el.hidden = !menuOpen;
    if (!menuOpen) return;
    layer.querySelector('#gMenuSeeds').textContent = nf(state.seeds);
    layer.querySelectorAll('.menu-tabs button').forEach((b) => {
      const t = /** @type {HTMLElement} */ (b).dataset.tab;
      b.classList.toggle('active', t === tab);
      if (t === 'missoes') {
        const n = state.missions.filter((x) => x.done && !x.claimed).length;
        b.textContent = n ? `Missões (${n})` : 'Missões';
      }
    });
    const body = /** @type {HTMLElement} */ (layer.querySelector('#gMenuBody'));
    if (force || body.dataset.tab !== tab) {
      body.dataset.tab = tab;
      body.innerHTML = '<div class="menu-row" id="gRow"></div>';
    }
    const row = /** @type {HTMLElement} */ (body.querySelector('#gRow'));
    if (tab === 'loja') renderShop(row);
    else if (tab === 'missoes') renderMissions(row);
    else renderBiomes(row);
  }

  function upsert(row, id, index, make) {
    let card = /** @type {HTMLElement|null} */ (row.querySelector(`[data-id="${CSS.escape(id)}"]`));
    if (!card) {
      card = document.createElement('div');
      card.dataset.id = id;
      card.innerHTML = make;
    }
    if (row.children[index] !== card) row.insertBefore(card, row.children[index] || null);
    return card;
  }

  function setHtml(el, html) {
    if (el && el.dataset.html !== html) {
      el.dataset.html = html;
      el.innerHTML = html;
    }
  }

  function renderShop(row) {
    const ids = new Set(state.shop.map((it) => it.id));
    for (const card of [...row.children]) if (!ids.has(/** @type {HTMLElement} */ (card).dataset.id)) card.remove();
    state.shop.forEach((it, i) => {
      const card = upsert(row, it.id, i, '<div class="sc-top"><span class="sc-title"></span><span class="sc-btn"></span></div><div class="sc-desc"></div>');
      card.className = 'shop-card' + (it.affordable && !it.maxed ? ' can' : '');
      const lvl = it.goal
        ? ` <small>${it.goal}</small>`
        : it.max !== null && isFinite(it.max) && it.max > 1
          ? ` <small>${it.level}/${it.max}</small>`
          : it.level
            ? ` <small>nív. ${it.level}</small>`
            : '';
      const btn = it.maxed
        ? '<button class="buy" disabled>Completo</button>'
        : `<button class="buy" data-buy="${esc(it.id)}" ${it.affordable ? '' : 'disabled'}>${toSvg(SEED_ICON, PAL, 1)} ${nf(it.cost)}</button>`;
      setHtml(card.querySelector('.sc-title'), esc(it.title) + lvl);
      setHtml(card.querySelector('.sc-btn'), btn);
      setHtml(card.querySelector('.sc-desc'), esc(it.desc));
      card.title = it.desc;
    });
  }

  function renderMissions(row) {
    state.missions.forEach((m, i) => {
      const card = upsert(row, 'm' + i, i, '<div class="sc-top"><span class="sc-title"></span><span class="sc-btn"></span></div><div class="mission-bar"><i></i></div><div class="sc-desc"></div>');
      card.className = 'shop-card mission' + (m.type === 'eco' ? ' eco' : '') + (m.done && !m.claimed ? ' can' : '') + (m.claimed ? ' claimed' : '');
      card.title = m.title;
      setHtml(card.querySelector('.sc-title'), (m.type === 'eco' ? '<span class="eco-tag">consciente</span> ' : '') + esc(m.title));
      const btn = m.claimed
        ? '<button class="buy" disabled>Resgatada</button>'
        : `<button class="buy" data-claim="${i}" ${m.done ? '' : 'disabled'}>${toSvg(SEED_ICON, PAL, 1)} +${nf(m.reward)}</button>`;
      setHtml(card.querySelector('.sc-btn'), btn);
      /** @type {HTMLElement} */ (card.querySelector('.mission-bar i')).style.width = Math.min(100, (m.progress / m.target) * 100) + '%';
      setHtml(card.querySelector('.sc-desc'), `${nf(m.progress)}/${nf(m.target)}` + (m.type === 'eco' ? ' · só conta com o planeta tranquilo ou radiante' : ''));
    });
    const chest = upsert(row, 'chest', state.missions.length, '<div class="chest-icon"></div><div class="sc-desc"></div>');
    chest.className = 'shop-card chest' + (state.chest ? ' opened' : '');
    setHtml(chest.querySelector('.chest-icon'), toSvg(CHEST_ICON, PAL, 3));
    setHtml(chest.querySelector('.sc-desc'), state.chest ? 'Baú do dia aberto! Volte amanhã.' : 'Complete as 3 missões para abrir o baú do dia.');
  }

  function renderBiomes(row) {
    state.biomes.forEach((b, i) => {
      const card = upsert(row, 'b' + b.id, i, '<div class="biome-pet"></div><div class="sc-title"></div><div class="sc-desc"></div>');
      card.className = 'shop-card biome ' + b.state;
      if (!card.dataset.drawn) {
        card.dataset.drawn = '1';
        /** @type {HTMLElement} */ (card.querySelector('.biome-pet')).innerHTML = framesFor(PETS[b.petId], 2).A;
      }
      const status = b.state === 'done' ? 'Restaurado' : b.state === 'current' ? `${state.biome.trees}/${b.need} árvores` : `${b.need} árvores`;
      setHtml(card.querySelector('.sc-title'), esc(b.name) + ` <small>${status}</small>`);
      setHtml(card.querySelector('.sc-desc'), b.state === 'done' ? `${esc(b.pet)} mora no quintal` : `Traz: ${esc(b.pet)} · +30% nas colheitas`);
    });
    const info = upsert(row, 'binfo', state.biomes.length, '<div class="sc-desc"></div>');
    info.className = 'shop-card biome-info';
    setHtml(
      info.querySelector('.sc-desc'),
      `Biomas restaurados: <b>${state.biome.restored}</b> · Bônus atual: <b>+${state.bonus}%</b><br>Depois da Amazônia começa uma nova volta, com metas maiores.`,
    );
  }

  // ---------------------------------------------------------------- ciclo

  function render() {
    if (!state || !ensureLayer()) return;
    const petsKey = state.pets.join(',');
    if (petsKey !== lastPets) {
      lastPets = petsKey;
      if (window.EcoDashboard) window.EcoDashboard.refreshPets();
      ensureLayer();
    }
    renderScenery();
    renderPlots();
    renderHud();
    renderMenu(false);
    for (const ev of state.events || []) {
      if (ev.kind === 'harvest' || ev.kind === undefined) {
        window.EcoPets.cancel('plot' + ev.plot);
        floatText(plotCenter(ev.plot, state.plots.length), `+${nf(ev.n)}`, ev.manual ? 'manual' : '');
      } else if (ev.kind === 'reward') {
        floatText(layer.clientWidth / 2, `+${nf(ev.n)}`, 'manual');
      } else if (ev.kind === 'chest') {
        toast(`Baú do dia: <b>+${nf(ev.n)} sementes</b>!`);
      } else if (ev.kind === 'biome') {
        confetti();
        toast(`<b>${esc(ev.name)} restaurado!</b> ${ev.pet ? esc(ev.pet) + ' veio morar no quintal. ' : ''}+${ev.bonus}% em todas as colheitas.`, true);
      }
    }
    if (state.offline > 0) toast(`Enquanto você estava fora, os bichinhos colheram <b>${nf(state.offline)}</b> sementes!`);
  }

  document.addEventListener('click', (e) => {
    const t = /** @type {HTMLElement} */ (e.target);
    const buy = /** @type {HTMLElement|null} */ (t.closest('[data-buy]'));
    const claim = /** @type {HTMLElement|null} */ (t.closest('[data-claim]'));
    const tabBtn = /** @type {HTMLElement|null} */ (t.closest('[data-tab]'));
    if (buy) vscode.postMessage({ type: 'game:buy', id: buy.dataset.buy });
    else if (claim) vscode.postMessage({ type: 'game:claim', index: Number(claim.dataset.claim) });
    else if (tabBtn) openMenu(tabBtn.dataset.tab);
    else if (t.closest('[data-close]')) openMenu(null);
  });

  window.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'game') {
      state = e.data.game;
      render();
    }
  });

  window.addEventListener('resize', () => {
    if (state && layer) {
      plotEls.forEach((p) => (p.stage = ''));
      renderPlots();
    }
  });

  window.EcoGame = {
    extraPets: () => (state ? state.pets : []),
  };

  if (window.EcoPets) {
    window.EcoPets.onArrive((id) => {
      if (id.startsWith('plot')) vscode.postMessage({ type: 'game:harvest', plot: Number(id.slice(4)), manual: false });
    });
    window.EcoPets.onPoke(() => vscode.postMessage({ type: 'game:pet' }));
  }
})();
