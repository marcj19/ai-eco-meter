// @ts-check
// "Quintal do planeta": desenha o jogo idle na aba Bichinhos. A lógica fica na extensão
// (src/game.js); aqui só desenhamos o estado recebido e mandamos as ações do jogador.
(function () {
  'use strict';

  if (document.body.dataset.mode !== 'yard') return;

  // a API do VS Code só pode ser obtida uma vez; o dashboard.js a compartilha
  const vscode = { postMessage: (m) => window.__vscodeApi && window.__vscodeApi.postMessage(m) };
  const { toSvg } = window.EcoSprites;

  const PAL = {
    g: '#5cc97a', G: '#2f8a4a', s: '#8b5a2b', S: '#6b4220', r: '#ff4d5e', y: '#ffd84d',
    o: '#ff9a3c', b: '#7a4a1f', w: '#fff4e0',
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
    // morango
    [EMPTY, '..g.....g.', '.rgg.g.ggr', '.rrggGggrr', '..r.gGg.r.', '....gGg...', '.....G....'],
    // cenoura
    ['...g..g...', '..gg.gg...', '...gggg.g.', '..g.gGgg..', '....gGg...', '....ooo...', '....ooo...'],
    // girassol
    ['...yyyy...', '..yybbyy..', '..ybbbby..', '..yybbyy..', '...yyyy...', '..g..G..g.', '...ggGgg..'],
  ];
  const TREE = [
    '....gggg....', '..gggGgggg..', '.gggggggGgg.', 'gggGgggggggg', 'ggggggGggggg', '.gggGggggGg.',
    '..gggggggg..', '....gggg....', '.....bb.....', '.....bb.....', '.....bb.....', '....bbbb....',
  ];
  const SEED_ICON = ['.gg.gg.', 'gGg.gGg', '..gGg..', '...G...', '..sss..', '.sssss.'];
  const TREE_ICON = ['..ggg..', '.gGggg.', 'gggggGg', '.ggGgg.', '...b...', '...b...'];

  const MOOD = {
    radiant: { label: 'Planeta radiante', cls: 'good' },
    calm: { label: 'Planeta tranquilo', cls: 'good' },
    worried: { label: 'Planeta preocupado', cls: 'mid' },
    hot: { label: 'Planeta com calor', cls: 'bad' },
  };

  const nf = (n) => Math.floor(n).toLocaleString('pt-BR');
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  let state = null;
  let layer = null;
  let shopOpen = false;
  const plotEls = [];
  let lastPets = '';
  let treesDrawn = -1;

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
        <span class="hud-item" title="Árvores plantadas">${toSvg(TREE_ICON, PAL, 2)}<b id="gTrees">0</b></span>
        <span class="hud-mood" id="gMood"></span>
        <span class="spacer"></span>
        <button class="hud-btn" id="gShopBtn">Loja</button>
      </div>
      <div class="game-shop" id="gShop" hidden></div>
      <div class="game-toast" id="gToast"></div>`;
    yard.appendChild(layer);
    layer.querySelector('#gShopBtn').addEventListener('click', () => toggleShop());
    plotEls.length = 0;
    treesDrawn = -1;
    return layer;
  }

  function plotCenter(i, n) {
    const w = layer.clientWidth;
    return Math.round((w * (i + 1)) / (n + 1));
  }

  function renderPlots() {
    const box = layer.querySelector('.game-plots');
    const n = state.plots.length;
    while (plotEls.length < n) {
      const el = document.createElement('div');
      el.className = 'plot';
      const idx = plotEls.length;
      el.addEventListener('click', () => {
        if (state && state.plots[idx] && state.plots[idx].p >= 1) {
          vscode.postMessage({ type: 'game:harvest', plot: idx, manual: true });
        }
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
        item.el.title = plot.p >= 1 ? 'Madura! Clique para colher (+25%)' : `Crescendo: ${Math.round(plot.p * 100)}%`;
      } else if (plot.p < 1) {
        item.el.title = `Crescendo: ${Math.round(plot.p * 100)}%`;
      }
      const cx = plotCenter(i, n);
      item.el.style.left = cx - pw / 2 + 'px';
      if (plot.p >= 1) window.EcoPets.request('plot' + i, cx);
    });
  }

  function renderTrees() {
    if (treesDrawn === state.trees) return;
    treesDrawn = state.trees;
    const box = layer.querySelector('.game-trees');
    box.innerHTML = '';
    for (let i = 0; i < state.trees; i++) {
      const t = document.createElement('span');
      // espalha as árvores de forma determinística, alternando entre as bordas e o meio
      const pos = ((i * 37) % 100) / 100;
      t.style.left = `calc(${(4 + pos * 88).toFixed(1)}% - 12px)`;
      t.style.setProperty('--d', (i % 5) * 0.4 + 's');
      t.innerHTML = toSvg(TREE, PAL, i % 3 === 0 ? 3 : 2);
      box.appendChild(t);
    }
  }

  function floatText(i, text, manual) {
    const n = state.plots.length;
    const f = document.createElement('div');
    f.className = 'float' + (manual ? ' manual' : '');
    f.textContent = text;
    f.style.left = plotCenter(i, n) + 'px';
    layer.appendChild(f);
    setTimeout(() => f.remove(), 1400);
  }

  function toast(text) {
    const t = layer.querySelector('#gToast');
    t.textContent = text;
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 7000);
  }

  function renderHud() {
    layer.querySelector('#gSeeds').textContent = nf(state.seeds);
    layer.querySelector('#gRate').textContent = `+${nf(state.rate * 60)}/min`;
    layer.querySelector('#gTrees').textContent = nf(state.trees);
    const m = MOOD[state.mood] || MOOD.calm;
    const moodEl = layer.querySelector('#gMood');
    const eff = state.moodSpeed >= 1 ? `+${Math.round((state.moodSpeed - 1) * 100)}%` : `−${Math.round((1 - state.moodSpeed) * 100)}%`;
    moodEl.textContent = `${m.label}: ${eff}`;
    moodEl.className = 'hud-mood ' + m.cls;
    moodEl.title = 'O ritmo da colheita acompanha o seu uso de IA hoje: dia leve rende mais, dia pesado deixa os bichinhos com calor.';
    const btn = layer.querySelector('#gShopBtn');
    btn.classList.toggle('pulse', state.shop.some((it) => it.affordable && !it.maxed));
  }

  /**
   * A loja é atualizada no lugar (sem recriar o HTML), senão a rolagem voltaria ao início
   * a cada segundo, inclusive no meio de um arrasto.
   */
  function renderShop() {
    const el = layer.querySelector('#gShop');
    el.hidden = !shopOpen;
    if (!shopOpen) return;
    if (!el.firstChild) {
      el.innerHTML =
        `<div class="shop-head"><b>Loja do quintal</b><span>${toSvg(SEED_ICON, PAL, 2)} <b id="gShopSeeds"></b></span><button class="hud-btn" data-close>Fechar</button></div>` +
        '<div class="shop-row" id="gShopRow"></div>';
    }
    el.querySelector('#gShopSeeds').textContent = nf(state.seeds);
    const row = el.querySelector('#gShopRow');
    const ids = new Set(state.shop.map((it) => it.id));
    for (const card of [...row.children]) if (!ids.has(card.dataset.id)) card.remove();
    state.shop.forEach((it, i) => {
      let card = /** @type {HTMLElement|null} */ (row.querySelector(`[data-id="${CSS.escape(it.id)}"]`));
      if (!card) {
        card = document.createElement('div');
        card.dataset.id = it.id;
        card.className = 'shop-card';
        card.innerHTML = '<div class="sc-top"><span class="sc-title"></span><span class="sc-btn"></span></div><div class="sc-desc"></div>';
      }
      if (row.children[i] !== card) row.insertBefore(card, row.children[i] || null);
      const lvl = it.max > 1 ? ` <small>${it.level}/${it.max}</small>` : '';
      const btn = it.maxed
        ? '<button class="buy" disabled>Completo</button>'
        : `<button class="buy" data-buy="${esc(it.id)}" ${it.affordable ? '' : 'disabled'}>${toSvg(SEED_ICON, PAL, 1)} ${nf(it.cost)}</button>`;
      setHtml(card.querySelector('.sc-title'), esc(it.title) + lvl);
      setHtml(card.querySelector('.sc-btn'), btn);
      setHtml(card.querySelector('.sc-desc'), esc(it.desc));
      card.title = it.desc;
      card.classList.toggle('can', it.affordable && !it.maxed);
    });
  }

  function setHtml(el, html) {
    if (el.dataset.html !== html) {
      el.dataset.html = html;
      el.innerHTML = html;
    }
  }

  function toggleShop(open) {
    shopOpen = open === undefined ? !shopOpen : open;
    renderShop();
  }

  function render() {
    if (!state || !ensureLayer()) return;
    const petsKey = state.pets.join(',');
    if (petsKey !== lastPets) {
      lastPets = petsKey;
      if (window.EcoDashboard) window.EcoDashboard.refreshPets();
      ensureLayer();
    }
    renderTrees();
    renderPlots();
    renderHud();
    renderShop();
    for (const ev of state.events || []) {
      window.EcoPets.cancel('plot' + ev.plot);
      floatText(ev.plot, `+${ev.n}`, ev.manual);
    }
    if (state.offline > 0) toast(`Enquanto você estava fora, os bichinhos colheram ${nf(state.offline)} sementes!`);
  }

  document.addEventListener('click', (e) => {
    const t = /** @type {HTMLElement} */ (e.target);
    const buy = t.closest('[data-buy]');
    if (buy) vscode.postMessage({ type: 'game:buy', id: /** @type {HTMLElement} */ (buy).dataset.buy });
    else if (t.closest('[data-close]')) toggleShop(false);
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
  }
})();
