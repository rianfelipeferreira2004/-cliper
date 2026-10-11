/* ============================================================================
   timeline.js — Timeline inferior: miniaturas, playhead, alças de corte,
   botões marcar início/fim e atalhos de teclado.
============================================================================ */
'use strict';

const Timeline = {
  cfg: null,          // { maxClipMinutos }
  inicializado: false,

  elementos() {
    return {
      trilha: document.getElementById('tl-trilha'),
      thumbs: document.getElementById('tl-thumbs'),
      playhead: document.getElementById('tl-playhead'),
      sel: document.getElementById('tl-selecao'),
      hIn: document.getElementById('tl-handle-in'),
      hOut: document.getElementById('tl-handle-out'),
      foraEsq: document.getElementById('tl-fora-esq'),
      foraDir: document.getElementById('tl-fora-dir'),
      tempo: document.getElementById('tl-tempo'),
      selInfo: document.getElementById('tl-sel-info'),
      btnPlay: document.getElementById('btn-play'),
      btnMute: document.getElementById('btn-mute'),
      btnIn: document.getElementById('btn-mark-in'),
      btnOut: document.getElementById('btn-mark-out'),
    };
  },

  iniciar(cfg) {
    if (this.inicializado) return;
    this.inicializado = true;
    this.cfg = cfg;
    const el = this.elementos();

    el.btnPlay.addEventListener('click', () => Editor.togglePlay());
    el.btnMute.addEventListener('click', () => Editor.toggleMute());
    el.btnIn.addEventListener('click', () => this.marcarInicio());
    el.btnOut.addEventListener('click', () => this.marcarFim());

    // Clique na trilha: move o playhead para ali
    el.trilha.addEventListener('pointerdown', (e) => {
      if (e.target === el.trilha || e.target.parentElement === el.thumbs || e.target.classList.contains('tl-fora')) {
        this.arrastarGenerico(el.trilha, e, (t) => Editor.buscar(t));
      }
    });
    // Playhead e alças arrastáveis
    this.arrastarGenerico(el.playhead, null, (t) => Editor.buscar(t));
    this.arrastarGenerico(el.hIn, null, (t) => this.definirInicio(t));
    this.arrastarGenerico(el.hOut, null, (t) => this.definirFim(t));

    // Atalhos de teclado (ignorados enquanto digita em campos)
    window.addEventListener('keydown', (e) => {
      if (e.target.matches('input, textarea, select') || Editor.aberto === false) return;
      switch (e.key) {
        case ' ': e.preventDefault(); Editor.togglePlay(); break;
        case 'i': case 'I': this.marcarInicio(); break;
        case 'o': case 'O': this.marcarFim(); break;
        case 'ArrowLeft': e.preventDefault(); Editor.passarFrame(-1); break;
        case 'ArrowRight': e.preventDefault(); Editor.passarFrame(1); break;
      }
    });
  },

  /** Converte posição do mouse na trilha para segundos */
  tempoDoEvento(trilha, e) {
    const r = trilha.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    return frac * (Editor.clip?.duracao || 0);
  },

  /**
   * Helper de arraste com pointer events:
   * se `eventoInicial` for passado, já começa arrastando (usado no clique da trilha).
   */
  arrastarGenerico(alvo, eventoInicial, aoMover) {
    const iniciar = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const trilha = document.getElementById('tl-trilha');
      alvo.setPointerCapture(e.pointerId);
      aoMover(this.tempoDoEvento(trilha, e));
      const mover = (ev) => aoMover(this.tempoDoEvento(trilha, ev));
      alvo.addEventListener('pointermove', mover);
      alvo.addEventListener('pointerup', () => alvo.removeEventListener('pointermove', mover), { once: true });
    };
    if (eventoInicial) iniciar(eventoInicial);
    else alvo.addEventListener('pointerdown', iniciar.bind(alvo));
  },

  carregar(clip) {
    const el = this.elementos();
    // Miniaturas geradas pelo backend (1 a cada N segundos)
    el.thumbs.innerHTML = '';
    const qtd = clip.miniaturas || 0;
    for (let i = 1; i <= qtd; i++) {
      const img = document.createElement('img');
      img.src = `/media/${clip.id}/thumbs/${i}.jpg`;
      img.alt = '';
      img.draggable = false;
      el.thumbs.appendChild(img);
    }
    this.atualizar();
  },

  marcarInicio() { this.definirInicio(Editor.video.currentTime); },
  marcarFim() { this.definirFim(Editor.video.currentTime); },

  definirInicio(t) {
    const st = Editor.estado;
    st.inicio = Math.max(0, Math.min(t, (st.fim ?? Infinity) - 0.1));
    Editor.salvarEstado();
    this.atualizar();
  },

  definirFim(t) {
    const dur = Editor.clip?.duracao || 0;
    const st = Editor.estado;
    st.fim = Math.min(dur, Math.max(t, (st.inicio ?? 0) + 0.1));
    Editor.salvarEstado();
    this.atualizar();
  },

  /** Sincroniza playhead/seleção/rótulos com o estado atual */
  atualizar() {
    if (Editor.aberto === false || !Editor.clip) return;
    const el = this.elementos();
    const dur = Editor.clip.duracao || 1;
    const t = Editor.video.currentTime || 0;
    const { inicio, fim } = Editor.estado;

    const pct = (v) => `${(v / dur) * 100}%`;
    el.playhead.style.left = pct(t);
    el.hIn.style.left = pct(inicio);
    el.hOut.style.left = pct(fim);
    el.sel.style.left = pct(inicio);
    el.sel.style.width = `calc(${pct(fim)} - ${pct(inicio)})`;
    el.foraEsq.style.left = '0';
    el.foraEsq.style.width = pct(inicio);
    el.foraDir.style.left = pct(fim);
    el.foraDir.style.width = `calc(100% - ${pct(fim)})`;

    el.tempo.textContent = `${fmtTempo(t)} / ${fmtTempo(dur)}`;

    // Duração selecionada + aviso se passar do limite
    const sel = fim - inicio;
    const limite = (this.cfg?.maxClipMinutes || 3) * 60;
    el.selInfo.textContent = `seleção: ${fmtDur(sel)} (máx ${fmtDur(limite)})`;
    el.selInfo.classList.toggle('aviso', sel > limite);
    el.selInfo.textContent = sel > limite
      ? `⚠ seleção de ${fmtDur(sel)} passa do máximo (${fmtDur(limite)})`
      : `seleção: ${fmtDur(sel)} (máx ${fmtDur(limite)})`;

    el.btnPlay.textContent = Editor.video.paused ? '▶' : '❚❚';
    el.btnMute.textContent = Editor.video.muted ? '🔇' : '🔊';
  },
};
