// @ts-check
// Sprites em pixel art, compartilhados entre o painel (navegador) e o editor (Node).
(function (root) {
  'use strict';

  const W = 16;
  const H = 11;

  // Cada sprite: 16×11, olhando para a direita. '.' = transparente.
  const PETS = {
    gato: {
      name: 'Gato',
      speed: 0.04,
      legRows: 2,
      pal: { o: '#f0a04b', d: '#c46f2a', e: '#2b2b2b', w: '#fff4e0', p: '#ff9fb0' },
      A: [
        '..........o...o.',
        '.d........oo.oo.',
        '.d.......oooooo.',
        '.d.......ooeoeo.',
        '..d......oowpwo.',
        '..doooooooooo...',
        '...oodoodoooo...',
        '...ooooooowwo...',
        '...oooooooooo...',
        '...o.o....o.o...',
        '...d.d....d.d...',
      ],
      B: [
        '....o.o..o.o....',
        '....d.d..d.d....',
      ],
      sounds: ['Miau.', 'Prrr…', 'Miau?'],
    },
    cachorro: {
      name: 'Cachorro',
      speed: 0.06,
      legRows: 2,
      pal: { b: '#b07a4a', n: '#6b4428', e: '#2b2b2b', k: '#1b1b1b', w: '#f3e3cf', t: '#ff7f94' },
      A: [
        '..........bbbb..',
        '.n.......bbbbbb.',
        '.n......nbbebb..',
        '..n.....nbbbbbbk',
        '..nbbbbbnbbbbt..',
        '...bbbbbbbbbb...',
        '...bbnnbbbbbb...',
        '...bbnnbbbbwb...',
        '...bbbbbbbbbb...',
        '...b.b....b.b...',
        '...n.n....n.n...',
      ],
      B: ['....b.b..b.b....', '....n.n..n.n....'],
      sounds: ['Au!', 'Au au!', '*abana o rabo*'],
    },
    pato: {
      name: 'Pato',
      speed: 0.03,
      legRows: 1,
      pal: { y: '#ffd84d', w: '#fff3b0', o: '#ff9a3c', e: '#2b2b2b' },
      A: [
        '................',
        '................',
        '..........yyy...',
        '.........yyyyy..',
        '.........yyeyyoo',
        '.........yyyyy..',
        '..y......yyyy...',
        '..yyyyyyyyyyy...',
        '..yyywwwwyyyy...',
        '...yyyyyyyyy....',
        '....o...o.......',
      ],
      B: ['.....o.o........'],
      sounds: ['Quack.', 'Quack quack!', 'Qua?'],
    },
    capivara: {
      name: 'Capivara',
      speed: 0.018,
      legRows: 2,
      pal: { c: '#a8784e', d: '#7a5433', e: '#2b2b2b', n: '#4a3020', o: '#ff9a2e', g: '#4caf50' },
      A: [
        '................',
        '............g...',
        '..........d.oo..',
        '.........cccccc.',
        '...cccccccceccc.',
        '..ccccccccccccn.',
        '..cccccccccccc..',
        '..cccdcccccccc..',
        '..cccccccccccc..',
        '...cc.....cc....',
        '...dd.....dd....',
      ],
      B: ['....cc...cc.....', '....dd...dd.....'],
      sounds: ['…', 'Relaxa.', 'Tudo no seu tempo.'],
    },
    tartaruga: {
      name: 'Tartaruga',
      speed: 0.01,
      legRows: 2,
      pal: { g: '#4f9d4a', h: '#2f6b2c', s: '#9ccc65', e: '#2b2b2b' },
      A: [
        '................',
        '................',
        '................',
        '................',
        '.....gggg.......',
        '....gghhgg..sss.',
        '...gghgghgg.sses',
        '..ggggggggggsss.',
        '..hhhhhhhhhh....',
        '...ss....ss.....',
        '................',
      ],
      B: ['....ss..ss......', '................'],
      sounds: ['Devagar e sempre.', 'Sem pressa.'],
    },
    caranguejo: {
      name: 'Caranguejo',
      speed: 0.03,
      legRows: 2,
      sideways: true,
      pal: { r: '#e5533d', R: '#a8321f', e: '#2b2b2b' },
      A: [
        '................',
        '................',
        '................',
        '..r..........r..',
        '.rr...e..e...rr.',
        '.rr...r..r...rr.',
        '..r.rrrrrrrr.r..',
        '...rrrrrrrrrr...',
        '...rrRrrrrRrr...',
        '..r.r.r..r.r.r..',
        '................',
      ],
      B: ['.r.r..r..r..r.r.', '................'],
      sounds: ['Clac clac.', '*anda de lado*'],
    },
  };

  const EMOTES = {
    heart: { pal: { r: '#ff5c7a' }, rows: ['rr.rr', 'rrrrr', 'rrrrr', '.rrr.', '..r..'] },
    sweat: { pal: { b: '#6cc4ff' }, rows: ['..b..', '.bbb.', 'bbbbb', 'bbbbb', '.bbb.'] },
    zzz: { pal: { z: '#9aa7b4' }, rows: ['zzzz.', '..z..', '.z...', 'zzzz.', '.....'] },
  };

  const DECOR = [
    { pal: { g: '#5cb85c' }, rows: ['g...g', '.g.g.', 'g.g.g'] },
    { pal: { y: '#ffd84d', o: '#ff9a3c', g: '#5cb85c' }, rows: ['.y.', 'yoy', '.y.', '.g.', 'gg.'] },
    { pal: { p: '#ff8fb8', y: '#ffd84d', g: '#5cb85c' }, rows: ['.p.', 'pyp', '.p.', '.g.', '.gg'] },
    { pal: { g: '#4caf50', G: '#3d8b40' }, rows: ['..g..', '.gGg.', 'gGgGg'] },
  ];

  /** Converte linhas de caracteres em SVG, juntando pixels vizinhos da mesma cor. */
  function toSvg(rows, pal, scale, cls) {
    const w = rows[0].length;
    const h = rows.length;
    let rects = '';
    rows.forEach((row, y) => {
      let x = 0;
      while (x < row.length) {
        const ch = row[x];
        let len = 1;
        while (row[x + len] === ch) len++;
        if (ch !== '.' && pal[ch]) rects += `<rect x="${x}" y="${y}" width="${len}" height="1" fill="${pal[ch]}"/>`;
        x += len;
      }
    });
    return `<svg class="${cls || ''}" viewBox="0 0 ${w} ${h}" width="${w * scale}" height="${h * scale}" shape-rendering="crispEdges" aria-hidden="true">${rects}</svg>`;
  }

  function framesFor(def, scale) {
    const legStart = H - def.legRows;
    const body = def.A.slice(0, legStart);
    const b = body.concat(def.B);
    const blank = '.'.repeat(W);
    const sleep = Array(def.legRows).fill(blank).concat(body).map((r) => r.replace(/e/g, 'c'));
    const pal = Object.assign({ c: '#555555' }, def.pal);
    return {
      A: toSvg(def.A, pal, scale),
      B: toSvg(b, pal, scale),
      sleep: toSvg(sleep, pal, scale),
    };
  }


  const api = { W, H, PETS, EMOTES, DECOR, toSvg, framesFor };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.EcoSprites = api;
})(typeof window !== 'undefined' ? window : globalThis);
