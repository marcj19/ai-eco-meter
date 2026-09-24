// @ts-check
// Bichinhos em pixel art que passeiam pelo rodapé do painel.
(function () {
  'use strict';

  const { W, H, PETS, EMOTES, DECOR, toSvg, framesFor } = window.EcoSprites;
  // No painel completo os bichinhos ficam maiores.
  const SCALE = document.body.dataset.mode === 'panel' ? 4 : 3;

  // ------------------------------------------------------------------ motor

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let yard = null;
  let pets = [];
  let timer = 0;
  let last = 0;
  let mood = 'calm';
  let facts = [];
  let currentIds = '';

  const rand = (a, b) => a + Math.random() * (b - a);
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

  function ensureYard() {
    if (yard) return yard;
    yard = document.createElement('div');
    yard.className = 'yard';
    yard.setAttribute('aria-label', 'Bichinhos passeando');
    const decor = document.createElement('div');
    decor.className = 'yard-decor';
    [8, 23, 41, 57, 72, 88].forEach((pct, i) => {
      const d = DECOR[i % DECOR.length];
      const s = document.createElement('span');
      s.style.left = pct + '%';
      s.innerHTML = toSvg(d.rows, d.pal, SCALE);
      decor.appendChild(s);
    });
    yard.appendChild(decor);
    document.body.appendChild(yard);
    return yard;
  }

  function spawn(ids) {
    pets.forEach((p) => p.el.remove());
    pets = [];
    const width = yard ? yard.clientWidth : 300;
    ids.forEach((id, i) => {
      const def = PETS[id];
      if (!def) return;
      const el = document.createElement('div');
      el.className = 'pet';
      el.title = def.name;
      el.innerHTML = `<div class="pet-bubble"></div><div class="pet-emote"></div><div class="pet-body"><div class="pet-sprite"></div></div>`;
      yard.appendChild(el);
      const p = {
        id,
        def,
        el,
        sprite: /** @type {HTMLElement} */ (el.querySelector('.pet-sprite')),
        body: /** @type {HTMLElement} */ (el.querySelector('.pet-body')),
        emote: /** @type {HTMLElement} */ (el.querySelector('.pet-emote')),
        bubble: /** @type {HTMLElement} */ (el.querySelector('.pet-bubble')),
        frames: framesFor(def, SCALE),
        x: ((i + 0.5) / ids.length) * Math.max(0, width - W * SCALE),
        dir: Math.random() < 0.5 ? -1 : 1,
        state: 'idle',
        t: rand(500, 2500),
        anim: 0,
        cur: '',
        emoteT: 0,
        bubbleT: 0,
      };
      p.emote.style.bottom = H * SCALE + 3 + 'px';
      p.bubble.style.bottom = H * SCALE + 20 + 'px';
      el.addEventListener('click', () => poke(p));
      pets.push(p);
      if (reduced) {
        p.state = i % 2 ? 'sleep' : 'idle';
      }
      draw(p);
    });
  }

  function setFrame(p, key) {
    if (p.cur === key) return;
    p.cur = key;
    p.sprite.innerHTML = p.frames[key];
  }

  function showEmote(p, kind, ms) {
    const e = EMOTES[kind];
    p.emote.innerHTML = toSvg(e.rows, e.pal, SCALE);
    p.emote.className = 'pet-emote show ' + kind;
    p.emoteT = ms;
  }

  function say(p, text, ms) {
    p.bubble.textContent = text;
    p.bubble.classList.add('show');
    p.bubbleT = ms;
    // mantém o balão dentro do quintal
    const yw = yard.clientWidth;
    const bw = p.bubble.offsetWidth;
    const center = p.x + (W * SCALE) / 2;
    let left = center - bw / 2;
    left = Math.max(4, Math.min(yw - bw - 4, left));
    p.bubble.style.left = left - p.x + 'px';
  }

  function poke(p) {
    p.state = 'idle';
    p.t = 3500;
    p.body.classList.remove('hop');
    void p.body.offsetWidth;
    p.body.classList.add('hop');
    showEmote(p, mood === 'hot' ? 'sweat' : 'heart', 1600);
    const line = Math.random() < 0.7 && facts.length ? pick(facts) : pick(p.def.sounds);
    say(p, line, 4200);
    draw(p);
  }

  function nextState(p) {
    const r = Math.random();
    const hot = mood === 'hot';
    const calmDay = mood === 'radiant' || mood === 'calm';
    const sleepChance = hot ? 0.08 : calmDay ? 0.22 : 0.14;
    if (r < sleepChance) {
      p.state = 'sleep';
      p.t = rand(7000, 15000);
    } else if (r < sleepChance + 0.3) {
      p.state = 'idle';
      p.t = rand(1500, 4500);
      if (hot && Math.random() < 0.6) showEmote(p, 'sweat', 1800);
      else if (mood === 'radiant' && Math.random() < 0.25) showEmote(p, 'heart', 1400);
    } else {
      p.state = 'walk';
      p.t = rand(2000, 6500);
      if (Math.random() < 0.5) p.dir *= -1;
    }
  }

  function update(p, dt, width) {
    p.t -= dt;
    if (p.emoteT > 0 && (p.emoteT -= dt) <= 0 && p.state !== 'sleep') p.emote.className = 'pet-emote';
    if (p.bubbleT > 0 && (p.bubbleT -= dt) <= 0) p.bubble.classList.remove('show');

    if (p.state === 'walk') {
      const speed = p.def.speed * (mood === 'hot' ? 0.65 : 1);
      p.x += p.dir * speed * dt;
      const max = Math.max(0, width - W * SCALE);
      if (p.x <= 0) {
        p.x = 0;
        p.dir = 1;
      } else if (p.x >= max) {
        p.x = max;
        p.dir = -1;
      }
      p.anim += dt;
    }
    if (p.t <= 0) {
      const wasSleeping = p.state === 'sleep';
      nextState(p);
      if (wasSleeping) p.emote.className = 'pet-emote';
      if (p.state === 'sleep') showEmote(p, 'zzz', p.t);
    }
    draw(p);
  }

  function draw(p) {
    if (p.state === 'walk') setFrame(p, Math.floor(p.anim / 220) % 2 ? 'B' : 'A');
    else if (p.state === 'sleep') setFrame(p, 'sleep');
    else setFrame(p, 'A');
    p.el.style.transform = `translateX(${p.x.toFixed(1)}px)`;
    p.sprite.style.transform = !p.def.sideways && p.dir < 0 ? 'scaleX(-1)' : '';
  }

  function tick() {
    const now = performance.now();
    const dt = Math.min(120, now - (last || now));
    last = now;
    if (document.visibilityState !== 'visible' || !yard) return;
    const width = yard.clientWidth;
    for (const p of pets) update(p, dt, width);
  }

  // ------------------------------------------------------------------ API

  window.EcoPets = {
    /**
     * @param {{enabled:boolean, list:string[], mood:string, facts:string[]}} opts
     */
    update(opts) {
      mood = opts.mood || 'calm';
      facts = opts.facts || [];
      const ids = (opts.list || []).filter((id) => PETS[id]).slice(0, 6);
      if (!opts.enabled || !ids.length) {
        if (yard) {
          yard.remove();
          yard = null;
        }
        pets = [];
        currentIds = '';
        clearInterval(timer);
        timer = 0;
        document.body.classList.remove('has-pets');
        return;
      }
      document.body.classList.add('has-pets');
      ensureYard();
      const key = ids.join(',');
      if (key !== currentIds) {
        currentIds = key;
        spawn(ids);
      }
      if (!timer && !reduced) {
        last = 0;
        timer = window.setInterval(tick, 50); // 20 fps basta para pixel art
      }
    },
    /** Ícone em pixel art (usado pelas conquistas). */
    pixel: toSvg,
  };
})();
