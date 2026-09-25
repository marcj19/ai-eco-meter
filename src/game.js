'use strict';
// "Quintal do planeta": jogo idle em que os bichinhos cultivam canteiros e colhem sementes.
// A lógica fica aqui, na extensão (fonte da verdade), e as webviews só desenham e mandam ações.
// Não depende da API do VS Code, para poder ser testado com Node puro.

const GROW_SECONDS = 24; // tempo para uma planta amadurecer, sem bônus
const AUTO_HARVEST_SECONDS = 12; // se nenhum bichinho chegar, a colheita acontece sozinha
const OFFLINE_MAX_SECONDS = 8 * 3600;
const OFFLINE_EFFICIENCY = 0.5;
const START_PLOTS = 3;
const MAX_PLOTS = 8;
const TREE_SEEDS_PER_SECOND = 0.05; // 1 semente a cada 20 s por árvore
const EXTRA_PETS = ['cachorro', 'tartaruga', 'caranguejo', 'gato', 'pato', 'capivara'];

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

function newState(now) {
  return {
    v: 1,
    seeds: 0,
    totalSeeds: 0,
    harvests: 0,
    trees: 0,
    treeCarry: 0,
    plots: Array.from({ length: START_PLOTS }, (_, i) => ({ p: 0, ripe: 0, kind: i % 3 })),
    upgrades: { regador: 0, adubo: 0, chapeu: 0 },
    pets: [],
    lastTick: now,
  };
}

const PET_NAMES = {
  gato: 'Gato',
  cachorro: 'Cachorro',
  pato: 'Pato',
  capivara: 'Capivara',
  tartaruga: 'Tartaruga',
  caranguejo: 'Caranguejo',
};

class Game {
  /**
   * @param {object|null} saved estado salvo anteriormente
   * @param {number} now
   */
  constructor(saved, now = Date.now()) {
    this.s = saved && saved.v === 1 ? saved : newState(now);
    this.mood = 'calm';
    this.basePets = [];
    this.events = []; // colheitas desde o último envio (para animar "+N")
    this.offlineGain = 0;
    this.applyOffline(now);
  }

  setMood(mood) {
    this.mood = mood || 'calm';
  }

  /** Bichinhos que já estão no quintal pela configuração (não aparecem para adoção). */
  setBasePets(list) {
    this.basePets = list || [];
  }

  speed() {
    return (1 + 0.25 * this.s.upgrades.regador) * moodSpeed(this.mood, this.s.upgrades.chapeu > 0);
  }

  yieldPerHarvest(manual) {
    const base = 3 + 2 * this.s.upgrades.adubo;
    const helpers = 1 + 0.15 * this.s.pets.length;
    return Math.ceil(base * helpers * (manual ? 1.25 : 1));
  }

  /** Sementes por segundo estimadas (para o progresso offline e o painel). */
  ratePerSecond(speed = this.speed()) {
    const perPlot = this.yieldPerHarvest(false) / (GROW_SECONDS / speed);
    return this.s.plots.length * perPlot + this.s.trees * TREE_SEEDS_PER_SECOND;
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

  addSeeds(n) {
    this.s.seeds += n;
    this.s.totalSeeds += n;
  }

  tick(now = Date.now()) {
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
    this.s.treeCarry += dt * this.s.trees * TREE_SEEDS_PER_SECOND;
    if (this.s.treeCarry >= 1) {
      const whole = Math.floor(this.s.treeCarry);
      this.s.treeCarry -= whole;
      this.addSeeds(whole);
    }
  }

  /** Colhe um canteiro maduro. Retorna quantas sementes rendeu (0 se não estava maduro). */
  harvest(index, manual) {
    const plot = this.s.plots[index];
    if (!plot || plot.p < 1) return 0;
    const n = this.yieldPerHarvest(manual);
    this.addSeeds(n);
    this.s.harvests++;
    plot.p = 0;
    plot.ripe = 0;
    plot.kind = (plot.kind + 1 + (index % 2)) % 3; // varia a planta: morango, cenoura, girassol
    this.events.push({ plot: index, n, manual: !!manual });
    return n;
  }

  shop() {
    const s = this.s;
    const items = [];
    const plotsBought = s.plots.length - START_PLOTS;
    items.push({
      id: 'canteiro',
      title: 'Novo canteiro',
      desc: 'Mais um canteiro para plantar',
      level: s.plots.length,
      max: MAX_PLOTS,
      cost: Math.round(15 * Math.pow(2.2, plotsBought)),
    });
    items.push({
      id: 'regador',
      title: 'Regador',
      desc: 'Plantas crescem 25% mais rápido',
      level: s.upgrades.regador,
      max: 6,
      cost: Math.round(25 * Math.pow(1.9, s.upgrades.regador)),
    });
    items.push({
      id: 'adubo',
      title: 'Adubo',
      desc: '+2 sementes por colheita',
      level: s.upgrades.adubo,
      max: 8,
      cost: Math.round(30 * Math.pow(1.8, s.upgrades.adubo)),
    });
    items.push({
      id: 'chapeu',
      title: 'Chapéu de palha',
      desc: 'Em dia quente, o ritmo cai só para 90% (em vez de 70%)',
      level: s.upgrades.chapeu,
      max: 1,
      cost: 60,
    });
    items.push({
      id: 'arvore',
      title: 'Plantar árvore',
      desc: 'Rende 1 semente a cada 20 s e deixa o quintal mais verde',
      level: s.trees,
      max: 12,
      cost: Math.round(80 * Math.pow(1.45, s.trees)),
    });
    const locked = EXTRA_PETS.filter((id) => !this.basePets.includes(id) && !s.pets.includes(id));
    if (locked.length) {
      const id = locked[0];
      items.push({
        id: 'pet:' + id,
        title: 'Adotar ' + PET_NAMES[id].toLowerCase(),
        desc: 'Um novo ajudante: +15% em todas as colheitas',
        level: s.pets.length,
        max: s.pets.length + locked.length,
        cost: Math.round(120 * Math.pow(2, s.pets.length)),
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
    else if (id === 'arvore') s.trees++;
    else if (item.pet) s.pets.push(item.pet);
    return true;
  }

  /** Estado enviado às webviews. */
  view() {
    const events = this.events;
    this.events = [];
    const offline = this.offlineGain;
    this.offlineGain = 0;
    return {
      seeds: Math.floor(this.s.seeds),
      totalSeeds: Math.floor(this.s.totalSeeds),
      harvests: this.s.harvests,
      trees: this.s.trees,
      plots: this.s.plots.map((p) => ({ p: p.p, kind: p.kind })),
      pets: this.s.pets.slice(),
      mood: this.mood,
      speed: this.speed(),
      moodSpeed: moodSpeed(this.mood, this.s.upgrades.chapeu > 0),
      rate: this.ratePerSecond(),
      shop: this.shop(),
      events,
      offline,
    };
  }

  save() {
    return this.s;
  }
}

module.exports = { Game, moodSpeed, GROW_SECONDS, AUTO_HARVEST_SECONDS };
