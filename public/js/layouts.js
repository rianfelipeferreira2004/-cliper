/* ============================================================================
   layouts.js — Presets de layout (slots no espaço de saída 1080×1920)
   ----------------------------------------------------------------------------
   Cada layout é uma lista de "slots": retângulos no canvas final onde as
   regiões são empilhadas. Coordenadas em pixels do espaço 1080×1920.
============================================================================ */
'use strict';

const LAYOUTS = {
  // 1 região em tela cheia
  'cheio': {
    nome: 'Tela cheia', desc: '1 região · 1080×1920',
    slots: [{ x: 0, y: 0, w: 1080, h: 1920 }],
    mini: [{ f: 1 }],
  },
  // 2 regiões empilhadas, metade/metade
  '50-50': {
    nome: 'Dividido 50/50', desc: '2 regiões · 960 px cada',
    slots: [
      { x: 0, y: 0, w: 1080, h: 960 },
      { x: 0, y: 960, w: 1080, h: 960 },
    ],
    mini: [{ f: 1 }, { f: 1 }],
  },
  // Jogo em cima (60%), webcam embaixo (40%)
  '60-40': {
    nome: 'Dividido 60/40', desc: 'Jogo em cima, webcam embaixo',
    slots: [
      { x: 0, y: 0, w: 1080, h: 1152 },
      { x: 0, y: 1152, w: 1080, h: 768 },
    ],
    mini: [{ f: 3 }, { f: 2 }],
  },
  // Webcam em cima (40%), jogo embaixo (60%)
  '40-60': {
    nome: 'Dividido 40/60', desc: 'Webcam em cima, jogo embaixo',
    slots: [
      { x: 0, y: 0, w: 1080, h: 768 },
      { x: 0, y: 768, w: 1080, h: 1152 },
    ],
    mini: [{ f: 2 }, { f: 3 }],
  },
  // Webcam pequena sobreposta no canto (picture-in-picture, cantos arredondados)
  'pip': {
    nome: 'Webcam sobreposta', desc: 'Tela cheia + PiP no canto',
    slots: [
      { x: 0, y: 0, w: 1080, h: 1920 },
      { x: 600, y: 1280, w: 420, h: 560, raio: 36, pip: true },
    ],
    mini: 'pip',
  },
  // Usuário arrasta a divisória entre 2 slots
  'personalizado': {
    nome: 'Personalizado', desc: 'Arraste a divisória',
    personalizado: true, // divisão começa em 60%
    slots: [
      { x: 0, y: 0, w: 1080, h: 1152 },
      { x: 0, y: 1152, w: 1080, h: 768 },
    ],
    mini: [{ f: 3 }, { f: 2 }],
  },
};

// Cores das regiões (como na referência: verde, laranja…)
const CORES_REGIAO = ['#3bff8c', '#ffb03b', '#4bc3ff'];

/** Recalcula os slots do layout personalizado a partir da divisão (0 a 1) */
function slotsDoLayout(id, divisao = 0.6) {
  const base = LAYOUTS[id];
  if (!base) return LAYOUTS['60-40'].slots;
  if (!base.personalizado) return base.slots;
  const hA = Math.round(1920 * divisao / 2) * 2; // par
  return [
    { x: 0, y: 0, w: 1080, h: hA },
    { x: 0, y: hA, w: 1080, h: 1920 - hA },
  ];
}

/* ============================================================================
   Headline flutuante: texto sobre o vídeo (sem faixa), na posição Y
   escolhida pelo usuário (espaço 1080×1920). Y padrão = divisa entre os
   slots empilhados, ou meio da tela (960) nos demais layouts.
============================================================================ */

/** Y padrão da headline para os slots atuais */
function headlineYPadrao(slots) {
  const a = slots[0];
  const b = slots[1];
  if (a && b && !a.pip && !b.pip && b.y === a.y + a.h) return a.y + a.h;
  return 960;
}
