'use strict';
// Coordena o jogo entre várias janelas do VS Code. Cada janela tem seu próprio processo de
// extensão; se todas rodassem o jogo, uma sobrescreveria o salvamento da outra.
// Solução: o estado fica num arquivo e só uma janela, a "dona", simula e grava. Ela renova a
// posse a cada segundo; se sumir por mais de LEASE_MS, outra janela assume. As demais leem o
// arquivo para desenhar o mesmo quintal e repassam cliques (colher, comprar) por arquivos de ação.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Game } = require('./game');

const LEASE_MS = 5000;
const EVENT_TTL_MS = 4000;

class GameHost {
  /**
   * @param {string} dir pasta de armazenamento global da extensão
   * @param {object|null} legacyState estado salvo por versões antigas (migração)
   */
  constructor(dir, legacyState) {
    this.dir = dir;
    this.file = path.join(dir, 'game.json');
    this.actionsDir = path.join(dir, 'game-actions');
    this.id = crypto.randomBytes(6).toString('hex');
    this.legacy = legacyState;
    this.game = null; // só existe enquanto esta janela é a dona
    this.mood = 'calm';
    this.basePets = [];
    this.recent = []; // eventos recentes gravados no arquivo (para as outras janelas animarem)
    this.seenEvents = new Set();
    this.pendingView = null;
    fs.mkdirSync(this.actionsDir, { recursive: true });
  }

  setMood(mood) {
    this.mood = mood;
    if (this.game) this.game.setMood(mood);
  }

  setBasePets(list) {
    this.basePets = list || [];
    if (this.game) this.game.setBasePets(this.basePets);
  }

  read() {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      return null;
    }
  }

  write(data) {
    const tmp = this.file + '.' + this.id + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, this.file); // troca atômica: quem lê nunca vê o arquivo pela metade
  }

  isOwner() {
    return !!this.game;
  }

  /** Um passo do jogo (chamado a cada segundo). Retorna o estado para desenhar. */
  tick(now = Date.now()) {
    const f = this.read();
    const free = !f || !f.owner || f.owner === this.id || now - (f.beat || 0) > LEASE_MS;
    if (free) {
      if (!this.game || (f && f.owner !== this.id)) {
        // assume o jogo a partir do último estado gravado (o construtor aplica o progresso offline)
        this.game = new Game((f && f.state) || this.legacy, now);
        this.recent = [];
      }
      this.game.setMood(this.mood);
      this.game.setBasePets(this.basePets);
      this.consumeActions();
      this.game.tick(now);
      const view = this.game.view();
      for (const ev of view.events) {
        ev.id = this.id + ':' + now + ':' + Math.random().toString(36).slice(2, 7);
        this.seenEvents.add(ev.id);
        this.recent.push(Object.assign({ t: now }, ev));
      }
      this.recent = this.recent.filter((ev) => now - ev.t < EVENT_TTL_MS);
      this.write({ owner: this.id, beat: now, state: this.game.save(), events: this.recent });
      return view;
    }

    // outra janela é a dona: só lê e desenha o mesmo quintal
    this.game = null;
    const mirror = new Game(f.state, f.beat || now);
    mirror.setMood(this.mood);
    mirror.setBasePets(this.basePets);
    const view = mirror.view();
    view.offline = 0;
    view.events = (f.events || []).filter((ev) => !this.seenEvents.has(ev.id));
    for (const ev of view.events) this.seenEvents.add(ev.id);
    if (this.seenEvents.size > 500) this.seenEvents = new Set([...this.seenEvents].slice(-100));
    return view;
  }

  /** Ação do jogador (colher/comprar). Aplica direto ou repassa para a janela dona. */
  action(a) {
    if (this.game) {
      return this.apply(a);
    }
    try {
      const name = Date.now() + '-' + crypto.randomBytes(4).toString('hex') + '.json';
      fs.writeFileSync(path.join(this.actionsDir, name), JSON.stringify(a));
    } catch {
      // ignora: o clique se perde, mas o jogo segue
    }
    return false;
  }

  apply(a) {
    if (a.type === 'harvest') return this.game.harvest(Number(a.plot), !!a.manual) > 0;
    if (a.type === 'buy') return this.game.buy(String(a.id));
    if (a.type === 'claim') return this.game.claim(Number(a.index));
    if (a.type === 'pet') return this.game.pet();
    return false;
  }

  consumeActions() {
    let files;
    try {
      files = fs.readdirSync(this.actionsDir).filter((n) => n.endsWith('.json')).sort();
    } catch {
      return;
    }
    for (const name of files) {
      const p = path.join(this.actionsDir, name);
      try {
        this.apply(JSON.parse(fs.readFileSync(p, 'utf8')));
      } catch {
        // ação corrompida: descarta
      }
      try {
        fs.unlinkSync(p);
      } catch {
        // outra janela pode ter apagado
      }
    }
  }

  /** Ao fechar a janela: grava e libera a posse para outra janela assumir na hora. */
  release() {
    if (!this.game) return;
    try {
      this.write({ owner: null, beat: 0, state: this.game.save(), events: [] });
    } catch {
      // melhor esforço
    }
    this.game = null;
  }
}

module.exports = { GameHost };
