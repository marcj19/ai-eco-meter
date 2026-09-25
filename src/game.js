'use strict';
// "Quintal do planeta": jogo idle em que os bichinhos cultivam canteiros e colhem sementes.
// A lógica fica aqui, na extensão (fonte da verdade), e as webviews só desenham e mandam ações.
// Não depende da API do VS Code, para poder ser testado com Node puro.
//
// Objetivos que mantêm o jogo vivo:
//  - Biomas: plantar árvores até restaurar cada bioma brasileiro (bônus permanente + bicho novo).
//    Depois do último, começa uma nova volta com metas maiores: o jogo não "zera".
//  - Missões do dia: 3 por dia, uma delas ligada ao uso consciente de IA.
//  - Melhorias sem nível máximo, com preço crescente.

const GROW_SECONDS = 24; // tempo para uma planta amadurecer, sem bônus
const AUTO_HARVEST_SECONDS = 12; // se nenhum bichinho chegar, a colheita acontece sozinha
const OFFLINE_MAX_SECONDS = 8 * 3600;
const OFFLINE_EFFICIENCY = 0.5;
const START_PLOTS = 3;
const MAX_PLOTS = 8;
const TREE_SEEDS_PER_SECOND = 0.05; // 1 semente a cada 20 s por árvore
const BIOME_BONUS = 0.3; // +30% nas colheitas por bioma restaurado
const EXTRA_PETS = ['cachorro', 'tartaruga', 'caranguejo', 'gato', 'pato', 'capivara'];

const BIOMES = [
  { id: 'cerrado', name: 'Cerrado', need: 8, pet: 'tamandua' },
  { id: 'caatinga', name: 'Caatinga', need: 10, pet: 'tatu' },
  { id: 'pantanal', name: 'Pantanal', need: 13, pet: 'arara' },
  { id: 'mata', name: 'Mata Atlântica', need: 16, pet: 'mico' },
  { id: 'amazonia', name: 'Amazônia', need: 20, pet: 'onca' },
];

const PET_NAMES = {
  gato: 'Gato',
  cachorro: 'Cachorro',
  pato: 'Pato',
  capivara: 'Capivara',
  tartaruga: 'Tartaruga',
  caranguejo: 'Caranguejo',
  tamandua: 'Tamanduá-bandeira',
  tatu: 'Tatu-bola',
  arara: 'Arara-azul',
  mico: 'Mico-leão-dourado',
  onca: 'Onça-pintada',
};

/** Multiplicador de crescimento pelo humor do planeta (uso de IA do dia). */
function moodSpeed(mood, hasHat) {
  switch (mood) {
    case 'radiant':
      return 1.5;
    case 'calm':
      return 1.2;
    case 'worried':
      return 1;
    case 'hot':
      return hasHat ? 0.9 : 0.7;
    default:
      return 1;
  }
}

function dayKey(ts) {
  const d = new Date(ts);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

/** Gerador pseudoaleatório com semente (as missões do dia são as mesmas em todas as janelas). */
function seeded(str) {
  let h = 2166136261;
  for (const c of str) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

function compact(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(1).replace('.', ',') + ' bi';
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace('.', ',') + ' mi';
  if (n >= 1e4) return Math.round(n / 1e3) + ' mil';
  return String(Math.round(n));
}

function newState(now) {
  return {
    v: 2,
    seeds: 0,
    totalSeeds: 0,
    harvests: 0,
    trees: 0, // árvores no bioma atual
    totalTrees: 0,
    treeCarry: 0,
    biome: 0, // índice do bioma atual (cresce para sempre: voltas extras)
    plots: Array.from({ length: START_PLOTS }, (_, i) => ({ p: 0, ripe: 0, kind: i % 3 })),
    upgrades: { regador: 0, adubo: 0, chapeu: 0 },
    pets: [],
    daily: null,
    lastTick: now,
  };
}

/** Converte saves da 0.6.x (v1) para o formato novo. */
function migrate(s) {
  if (s.v === 1) {
    s.v = 2;
    s.totalTrees = s.trees || 0;
    s.biome = 0;
    s.daily = null;
  }
  return s;
}

class Game {
  /**
   * @param {object|null} saved estado salvo anteriormente
   * @param {number} now
   */
  constructor(saved, now = Date.now()) {
    this.s = saved && (saved.v === 1 || saved.v === 2) ? migrate(saved) : newState(now);
    this.mood = 'calm';
    this.basePets = [];
    this.events = []; // colheitas e conquistas desde o último envio (para animar)
    this.offlineGain = 0;
    this.applyOffline(now);
    this.checkBiome();
  }

  setMood(mood) {
    this.mood = mood || 'calm';
  }

  /** Bichinhos que já estão no quintal pela configuração (não aparecem para adoção). */
  setBasePets(list) {
    this.basePets = list || [];
  }

  // ---------------------------------------------------------------- economia

  speed() {
    return (1 + 0.25 * this.s.upgrades.regador) * moodSpeed(this.mood, this.s.upgrades.chapeu > 0);
  }

  bonus() {
    return 1 + BIOME_BONUS * this.s.biome;
  }

  yieldPerHarvest(manual) {
    const base = 3 + 2 * this.s.upgrades.adubo;
    const helpers = 1 + 0.15 * this.s.pets.length;
    return Math.ceil(base * helpers * this.bonus() * (manual ? 1.25 : 1));
  }

  /** Sementes por segundo estimadas (para o progresso offline, missões e o painel). */
  ratePerSecond(speed = this.speed()) {
    const perPlot = this.yieldPerHarvest(false) / (GROW_SECONDS / speed);
    return this.s.plots.length * perPlot + this.s.trees * TREE_SEEDS_PER_SECOND * this.bonus();
  }

  applyOffline(now) {
    const elapsed = Math.min(OFFLINE_MAX_SECONDS, Math.max(0, (now - this.s.lastTick) / 1000));
    if (elapsed > 60) {
      // offline não sabemos o humor de cada dia: usa o ritmo neutro
      const gain = Math.floor(elapsed * this.ratePerSecond(1 + 0.25 * this.s.upgrades.regador) * OFFLINE_EFFICIENCY);
      if (gain > 0) {
        this.addSeeds(gain);
        this.offlineGain = gain;
      }
    }
    this.s.lastTick = now;
  }

  addSeeds(n, fromPlay = false) {
    this.s.seeds += n;
    this.s.totalSeeds += n;
    if (fromPlay) this.progress('seeds', n);
  }

  // ---------------------------------------------------------------- biomas

  biomeInfo(index = this.s.biome) {
    const b = BIOMES[index % BIOMES.length];
    const lap = Math.floor(index / BIOMES.length) + 1;
    const need = Math.round(b.need * (1 + 0.5 * (lap - 1)));
    return Object.assign({}, b, { index, lap, need });
  }

  checkBiome() {
    let info = this.biomeInfo();
    while (this.s.trees >= info.need) {
      this.s.trees -= info.need;
      this.s.biome++;
      const firstLap = info.lap === 1;
      if (firstLap && !this.s.pets.includes(info.pet)) this.s.pets.push(info.pet);
      this.events.push({ kind: 'biome', name: info.name, pet: firstLap ? PET_NAMES[info.pet] : null, bonus: Math.round(BIOME_BONUS * 100) });
      info = this.biomeInfo();
    }
  }

  // ---------------------------------------------------------------- missões do dia

  ensureDaily(now) {
    const today = dayKey(now);
    if (this.s.daily && this.s.daily.date === today) return;
    const rand = seeded('missoes-' + today);
    const plots = this.s.plots.length;
    const reward = Math.max(40, Math.round(this.ratePerSecond(1.2 + 0.3 * this.s.upgrades.regador) * 60 * 8));
    const pool = [
      { type: 'harvest', target: 20 + 5 * plots },
      { type: 'manual', target: 8 },
      { type: 'tree', target: 1 },
      { type: 'buy', target: 3 },
      { type: 'pet', target: 5 },
      { type: 'seeds', target: Math.max(100, Math.round(reward * 2.5)) },
    ];
    const picks = [];
    while (picks.length < 2) {
      const m = pool[Math.floor(rand() * pool.length)];
      if (!picks.includes(m)) picks.push(m);
    }
    const eco = { type: 'eco', target: 15 + 3 * plots };
    this.s.daily = {
      date: today,
      chest: false,
      missions: [eco, ...picks].map((m) => ({
        type: m.type,
        target: m.target,
        progress: 0,
        reward: m.type === 'eco' ? reward * 2 : reward,
        claimed: false,
      })),
    };
  }

  progress(type, n = 1) {
    const d = this.s.daily;
    if (!d) return;
    for (const m of d.missions) if (m.type === type && !m.claimed) m.progress = Math.min(m.target, m.progress + n);
  }

  claim(index) {
    const d = this.s.daily;
    const m = d && d.missions[index];
    if (!m || m.claimed || m.progress < m.target) return false;
    m.claimed = true;
    this.addSeeds(m.reward);
    this.events.push({ kind: 'reward', n: m.reward });
    if (!d.chest && d.missions.every((x) => x.claimed)) {
      d.chest = true;
      const chest = m.reward * 3;
      this.addSeeds(chest);
      this.events.push({ kind: 'chest', n: chest });
    }
    return true;
  }

  static missionTitle(m) {
    switch (m.type) {
      case 'eco':
        return `Colher ${m.target} vezes com o planeta tranquilo ou radiante`;
      case 'harvest':
        return `Colher ${m.target} vezes`;
      case 'manual':
        return `Colher ${m.target} plantas com um clique`;
      case 'tree':
        return 'Plantar 1 árvore';
      case 'buy':
        return `Fazer ${m.target} compras na loja`;
      case 'pet':
        return `Fazer carinho em ${m.target} bichinhos`;
      case 'seeds':
        return `Juntar ${compact(m.target)} sementes hoje`;
      default:
        return m.type;
    }
  }

  /** Carinho num bichinho (clique na aba). */
  pet() {
    this.progress('pet');
    return true;
  }

  // ---------------------------------------------------------------- ciclo

  tick(now = Date.now()) {
    this.ensureDaily(now);
    const dt = Math.min(5, Math.max(0, (now - this.s.lastTick) / 1000));
    this.s.lastTick = now;
    const grow = (dt * this.speed()) / GROW_SECONDS;
    this.s.plots.forEach((plot, i) => {
      if (plot.p < 1) {
        plot.p = Math.min(1, plot.p + grow);
      } else {
        plot.ripe += dt;
        if (plot.ripe >= AUTO_HARVEST_SECONDS) this.harvest(i, false);
      }
    });
    this.s.treeCarry += dt * this.s.trees * TREE_SEEDS_PER_SECOND * this.bonus();
    if (this.s.treeCarry >= 1) {
      const whole = Math.floor(this.s.treeCarry);
      this.s.treeCarry -= whole;
      this.addSeeds(whole, true);
    }
  }

  /** Colhe um canteiro maduro. Retorna quantas sementes rendeu (0 se não estava maduro). */
  harvest(index, manual) {
    const plot = this.s.plots[index];
    if (!plot || plot.p < 1) return 0;
    this.ensureDaily(Date.now());
    const n = this.yieldPerHarvest(manual);
    this.addSeeds(n, true);
    this.s.harvests++;
    this.progress('harvest');
    if (manual) this.progress('manual');
    if (this.mood === 'calm' || this.mood === 'radiant') this.progress('eco');
    plot.p = 0;
    plot.ripe = 0;
    plot.kind = (plot.kind + 1 + (index % 2)) % 3; // varia a planta: morango, cenoura, girassol
    this.events.push({ kind: 'harvest', plot: index, n, manual: !!manual });
    return n;
  }

  shop() {
    const s = this.s;
    const b = this.biomeInfo();
    const items = [];
    items.push({
      id: 'arvore',
      title: 'Plantar árvore',
      desc: `Ajuda a restaurar o ${b.name} e rende sementes sozinha`,
      level: s.trees,
      max: Infinity,
      goal: `${s.trees}/${b.need}`,
      cost: Math.round(300 * Math.pow(1.3, s.trees) * Math.pow(3.6, s.biome)),
    });
    items.push({
      id: 'canteiro',
      title: 'Novo canteiro',
      desc: 'Mais um canteiro para plantar',
      level: s.plots.length,
      max: MAX_PLOTS,
      cost: Math.round(15 * Math.pow(2.2, s.plots.length - START_PLOTS)),
    });
    items.push({
      id: 'regador',
      title: 'Regador',
      desc: 'Plantas crescem 25% mais rápido',
      level: s.upgrades.regador,
      max: Infinity,
      cost: Math.round(25 * Math.pow(2.6, s.upgrades.regador)),
    });
    items.push({
      id: 'adubo',
      title: 'Adubo',
      desc: '+2 sementes por colheita (antes dos bônus)',
      level: s.upgrades.adubo,
      max: Infinity,
      cost: Math.round(30 * Math.pow(2.4, s.upgrades.adubo)),
    });
    items.push({
      id: 'chapeu',
      title: 'Chapéu de palha',
      desc: 'Em dia quente, o ritmo cai só para 90% (em vez de 70%)',
      level: s.upgrades.chapeu,
      max: 1,
      cost: 60,
    });
    const locked = EXTRA_PETS.filter((id) => !this.basePets.includes(id) && !s.pets.includes(id));
    if (locked.length) {
      const id = locked[0];
      const adopted = s.pets.filter((p) => EXTRA_PETS.includes(p)).length;
      items.push({
        id: 'pet:' + id,
        title: 'Adotar ' + PET_NAMES[id].toLowerCase(),
        desc: 'Um novo ajudante: +15% em todas as colheitas',
        level: adopted,
        max: adopted + locked.length,
        cost: Math.round(120 * Math.pow(2, adopted)),
        pet: id,
      });
    }
    return items.map((it) => Object.assign(it, { maxed: it.level >= it.max, affordable: s.seeds >= it.cost }));
  }

  buy(id) {
    const item = this.shop().find((it) => it.id === id);
    if (!item || item.maxed || this.s.seeds < item.cost) return false;
    this.s.seeds -= item.cost;
    const s = this.s;
    if (id === 'canteiro') s.plots.push({ p: 0, ripe: 0, kind: s.plots.length % 3 });
    else if (id === 'regador' || id === 'adubo' || id === 'chapeu') s.upgrades[id]++;
    else if (id === 'arvore') {
      s.trees++;
      s.totalTrees++;
      this.progress('tree');
      this.checkBiome();
    } else if (item.pet) s.pets.push(item.pet);
    this.progress('buy');
    return true;
  }

  // ---------------------------------------------------------------- saída

  /** Estado enviado às webviews. */
  view() {
    const events = this.events;
    this.events = [];
    const offline = this.offlineGain;
    this.offlineGain = 0;
    this.ensureDaily(this.s.lastTick);
    const b = this.biomeInfo();
    const d = this.s.daily;
    return {
      seeds: Math.floor(this.s.seeds),
      totalSeeds: Math.floor(this.s.totalSeeds),
      harvests: this.s.harvests,
      trees: this.s.trees,
      totalTrees: this.s.totalTrees,
      plots: this.s.plots.map((p) => ({ p: p.p, kind: p.kind })),
      pets: this.s.pets.slice(),
      mood: this.mood,
      speed: this.speed(),
      moodSpeed: moodSpeed(this.mood, this.s.upgrades.chapeu > 0),
      rate: this.ratePerSecond(),
      bonus: Math.round((this.bonus() - 1) * 100),
      biome: { id: b.id, name: b.name, lap: b.lap, trees: this.s.trees, need: b.need, restored: this.s.biome },
      biomes: BIOMES.map((x, i) => {
        const lapOf = Math.floor(this.s.biome / BIOMES.length);
        const pos = this.s.biome % BIOMES.length;
        const state = lapOf > 0 || i < pos ? 'done' : i === pos ? 'current' : 'locked';
        return { id: x.id, name: x.name, pet: PET_NAMES[x.pet], petId: x.pet, need: this.biomeInfo(lapOf * BIOMES.length + i).need, state };
      }),
      missions: d.missions.map((m) => ({
        title: Game.missionTitle(m),
        type: m.type,
        progress: m.progress,
        target: m.target,
        reward: m.reward,
        claimed: m.claimed,
        done: m.progress >= m.target,
      })),
      chest: d.chest,
      shop: this.shop(),
      events,
      offline,
    };
  }

  save() {
    return this.s;
  }
}

module.exports = { Game, moodSpeed, BIOMES, PET_NAMES, GROW_SECONDS, AUTO_HARVEST_SECONDS };
