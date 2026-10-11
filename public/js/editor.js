/* ============================================================================
   editor.js — Editor principal: regiões arrastáveis, preview 9:16 em canvas,
   painel de camadas, layouts, zoom e configurações.
   ----------------------------------------------------------------------------
   - As regiões são guardadas em coordenadas NORMALIZADAS (0..1) do vídeo de
     origem, então funcionam em qualquer resolução de tela.
   - A proporção de cada região fica travada à do seu slot de saída
     (largura ÷ altura do slot), então nada sai esticado.
   - O preview de saída usa <canvas> + requestAnimationFrame com drawImage
     recortado: mostra o resultado exato sem renderizar nada.
============================================================================ */
'use strict';

const Editor = {
  aberto: false,
  clip: null,          // metadados vindos do backend
  video: null,         // elemento <video> de origem
  canvas: null,
  ctx: null,
  estado: null,        // { layout, divisao, regioes, inicio, fim, fundo, ... }
  regiaoSel: 0,        // índice da região selecionada
  zoom: 1,
  _raf: 0,
  _salvarTimer: null,

  // --------------------------------------------------------------------------
  // Abertura
  // --------------------------------------------------------------------------

  async abrir(id) {
    this.aberto = true;
    this.mostrarView();
    // Pré-carrega a fonte da headline para o canvas medir certo
    if (document.fonts?.load) {
      document.fonts.load('84px Anton').catch(() => {});
    }
    this.video = document.getElementById('video-fonte');
    this.canvas = document.getElementById('canvas-saida');
    this.ctx = this.canvas.getContext('2d');

    // Busca metadados atualizados
    let clip;
    try {
      ({ clip } = await api(`/api/clips/${id}`));
    } catch (e) {
      toast(e.message, 'erro');
      location.hash = '#/';
      return;
    }
    if (clip.status !== 'pronto') {
      toast('Este clipe ainda não está pronto. Aguarde o download terminar.', 'erro');
      location.hash = '#/';
      return;
    }
    this.clip = clip;
    document.getElementById('bc-titulo').textContent = clip.titulo || 'Novo clipe';

    // Estado: restaura o que foi salvo ou cria o padrão (60/40, 2 regiões)
    this.estado = clip.editor || this.estadoPadrao();
    if (!this.estado.headline) this.estado.headline = { texto: '', tamanho: 84, y: null };
    this.regiaoSel = 0;
    this.zoom = 1;

    // Carrega o vídeo local (seek instantâneo, funciona offline)
    this.video.muted = false;
    this.video.volume = (this.estado.volume ?? 100) / 100;
    this.video.src = `/media/${clip.id}/source.mp4`;
    this.video.load();

    this.video.onloadedmetadata = () => {
      if (this.estado.fim == null || this.estado.fim <= 0) {
        this.estado.inicio = 0;
        this.estado.fim = this.video.duration || clip.duracao || 0;
      }
      this.aplicarZoom();
      Timeline.carregar(clip);
      // Migração do modo faixa antigo: fixa o Y na divisa e reajusta tudo
      if (this.estado.headline?.texto && this.estado.headline.y == null) {
        this.estado.headline.y = headlineYPadrao(this.slotsAtuais());
        // Reajuste mínimo das regiões (preserva centro e enquadramento,
        // só corrige a largura à proporção dos slots cheios)
        const vw = this.video.videoWidth, vh = this.video.videoHeight;
        const slots = this.slotsAtuais();
        this.estado.regioes.forEach((r) => {
          const s = slots[r.slot];
          if (!s || r.slot < 0) return;
          const razao = (s.w / s.h) * (vh / vw);
          const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
          let w = r.h * razao, h = r.h;
          if (w > 1) { w = 1; h = w / razao; }
          r.w = w; r.h = Math.min(1, h);
          r.x = Math.min(1 - r.w, Math.max(0, cx - r.w / 2));
          r.y = Math.min(1 - r.h, Math.max(0, cy - r.h / 2));
        });
        this.salvarEstado();
      }
      this.montarRegioes();
      this.desenharCamadas();
      this.sincronizarPainelConfigs();
      Timeline.atualizar();
    };
    this.video.onplay = () => Timeline.atualizar();
    this.video.onpause = () => Timeline.atualizar();

    // Corte: pausa ao chegar no fim da seleção
    this.video.ontimeupdate = () => {
      if (!this.video.paused && this.video.currentTime >= this.estado.fim - 0.03) {
        this.video.pause();
        this.video.currentTime = this.estado.fim;
      }
      Timeline.atualizar();
    };

    Timeline.iniciar(window.FREECLIP_CFG || {});
    this.iniciarLoop();
  },

  fechar() {
    this.aberto = false;
    cancelAnimationFrame(this._raf);
    if (this.video) { this.video.pause(); this.video.removeAttribute('src'); this.video.load(); }
    this.clip = null;
    this.estado = null;
    document.getElementById('view-editor').hidden = true;
    document.getElementById('view-biblioteca').hidden = false;
  },

  mostrarView() {
    document.getElementById('view-biblioteca').hidden = true;
    document.getElementById('view-editor').hidden = false;
  },

  /** Estado inicial: layout 60/40 com Jogo em cima e Webcam embaixo */
  estadoPadrao() {
    const vw = this.clip?.largura || 1280;
    const vh = this.clip?.altura || 720;
    const slots = slotsDoLayout('60-40');
    return {
      layout: '60-40',
      divisao: 0.6,
      regioes: [
        { nome: 'Principal', cor: CORES_REGIAO[0], slot: 0, travada: false,
          ...this.encaixarNoSlot(slots[0], vw, vh, 0.5, 0.5) },
        { nome: 'Webcam', cor: CORES_REGIAO[1], slot: 1, travada: false,
          ...this.encaixarNoSlot(slots[1], vw, vh, 0.5, 0.5) },
      ],
      inicio: 0,
      fim: this.clip?.duracao || 0,
      fundo: 'preto',
      fundoCor: '#121218',
      ajuste: 'preencher',
      audio: true,
      volume: 100,
      travaProporcao: true,
      headline: { texto: '', tamanho: 84, y: null },
    };
  },

  // --------------------------------------------------------------------------
  // Slots e proporção
  // --------------------------------------------------------------------------

  slotsAtuais() {
    return slotsDoLayout(this.estado.layout, this.estado.divisao);
  },

  /** Y da headline no espaço 1080×1920 (0 = topo, 1920 = base) */
  headlineY() {
    const hl = this.estado?.headline;
    const y = Number(hl?.y);
    if (Number.isFinite(y)) return Math.min(1920, Math.max(0, y));
    return headlineYPadrao(this.slotsAtuais());
  },

  /**
   * Reajusta a proporção das regiões aos slots (usado ao ligar/desligar
   * a headline, trocar de layout, etc.).
   */
  aplicarHeadline() {
    const st = this.estado;
    if (st.headline?.texto.trim() && st.headline.y == null) {
      st.headline.y = headlineYPadrao(this.slotsAtuais());
    }
    const slots = this.slotsAtuais();
    const vw = this.video.videoWidth || 1280;
    const vh = this.video.videoHeight || 720;
    st.regioes.forEach((r) => {
      if (r.slot >= 0 && r.slot < slots.length) {
        const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
        Object.assign(r, this.encaixarNoSlot(slots[r.slot], vw, vh, cx, cy));
      }
    });
    this.montarRegioes();
    this.desenharCamadas();
    this.salvarEstado();
  },

  /** Maior retângulo com a proporção do slot, centrado em (cx, cy) */
  encaixarNoSlot(slot, vw, vh, cx = 0.5, cy = 0.5) {
    const A = slot.w / slot.h; // proporção exigida (espaço de saída)
    let rw = vw, rh = rw / A;
    if (rh > vh) { rh = vh; rw = rh * A; }
    const w = rw / vw, h = rh / vh;
    return {
      x: Math.min(1 - w, Math.max(0, cx - w / 2)),
      y: Math.min(1 - h, Math.max(0, cy - h / 2)),
      w, h,
    };
  },

  /** Troca de layout: reaproveita as regiões e reajusta proporção/posição */
  aplicarLayout(id, divisao) {
    const st = this.estado;
    st.layout = id;
    if (divisao != null) st.divisao = divisao;
    const slots = this.slotsAtuais();
    const vw = this.video.videoWidth || 1280;
    const vh = this.video.videoHeight || 720;
    // Reatribui slots em ordem; excedentes ficam sem slot (preservados)
    const ordenadas = [...st.regioes].sort((a, b) => a.slot - b.slot);
    ordenadas.forEach((r, i) => {
      r.slot = i < slots.length ? i : -1;
      if (r.slot >= 0) {
        const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
        Object.assign(r, this.encaixarNoSlot(slots[r.slot], vw, vh, cx, cy));
      }
    });
    st.regioes = ordenadas;
    this.regiaoSel = 0;
    this.montarRegioes();
    this.desenharCamadas();
    this.salvarEstado();
    this.marcarLayoutAtivo();
  },

  // --------------------------------------------------------------------------
  // Regiões: montar, arrastar, redimensionar
  // --------------------------------------------------------------------------

  palco() { return document.getElementById('palco-entrada'); },

  montarRegioes() {
    const camada = document.getElementById('camada-regioes');
    camada.innerHTML = '';
    this.estado.regioes.forEach((r, i) => {
      const el = document.createElement('div');
      el.className = 'regiao' + (i === this.regiaoSel ? ' selecionada' : '') + (r.travada ? ' travada' : '');
      el.style.color = r.cor;
      el.dataset.idx = i;
      el.innerHTML = `<span class="rotulo-regiao">${esc(r.nome)}</span>` +
        ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']
          .map((p) => `<span class="alca" data-pos="${p}"></span>`).join('');
      this.posicionarEl(el, r);
      el.addEventListener('pointerdown', (e) => {
        if (e.target.classList.contains('alca')) return;
        this.regiaoSel = i;
        this.atualizarSelecaoVisual();
      }, true);
      camada.appendChild(el);
      if (!r.travada) {
        this.tornarArrastavel(el, i);
        el.querySelectorAll('.alca').forEach((alca) => this.tornarRedimensionavel(alca, i));
      }
    });
  },

  posicionarEl(el, r) {
    el.style.left = `${r.x * 100}%`;
    el.style.top = `${r.y * 100}%`;
    el.style.width = `${r.w * 100}%`;
    el.style.height = `${r.h * 100}%`;
  },

  atualizarSelecaoVisual() {
    document.querySelectorAll('#camada-regioes .regiao').forEach((el) => {
      el.classList.toggle('selecionada', Number(el.dataset.idx) === this.regiaoSel);
    });
  },

  /** Arrastar a região (interact.js), com trava nos limites do vídeo */
  tornarArrastavel(el, i) {
    interact(el).draggable({
      listeners: {
        move: (e) => {
          const r = this.estado.regioes[i];
          const pw = this.palco().clientWidth, ph = this.palco().clientHeight;
          r.x = Math.min(1 - r.w, Math.max(0, r.x + e.dx / pw));
          r.y = Math.min(1 - r.h, Math.max(0, r.y + e.dy / ph));
          this.posicionarEl(el, r);
          this.salvarEstado();
        },
      },
    });
  },

  /**
   * Redimensionar por alça (interact.js em cada alça).
   * Com a proporção travada, altura e largura andam juntas na razão do slot.
   */
  tornarRedimensionavel(alca, i) {
    const pos = alca.dataset.pos;
    let ini = null, accX = 0, accY = 0;
    interact(alca).draggable({
      listeners: {
        start: () => {
          ini = { ...this.estado.regioes[i] };
          accX = 0; accY = 0;
        },
        move: (e) => {
          const st = this.estado;
          const r = st.regioes[i];
          const pw = this.palco().clientWidth, ph = this.palco().clientHeight;
          accX += e.dx; accY += e.dy;
          const dx = accX / pw, dy = accY / ph; // deltas normalizados

          const slot = this.slotsAtuais()[r.slot];
          const travada = st.travaProporcao && slot;
          // Razão w/h em unidades normalizadas (converte proporção do slot)
          const vw = this.video.videoWidth || 1280, vh = this.video.videoHeight || 720;
          const razao = slot ? (slot.w / slot.h) * (vh / vw) : ini.w / ini.h;

          let { x, y, w, h } = ini;
          const MIN = 0.03;

          // Largura nova conforme a alça (âncora no lado oposto)
          if (pos.includes('e')) { w = Math.max(MIN, ini.w + dx); }
          if (pos.includes('w')) { w = Math.max(MIN, ini.w - dx); x = ini.x + ini.w - w; }
          // Altura nova (se travada, deriva da largura, e vice-versa)
          if (travada) {
            if (pos === 'n' || pos === 's') { // borda horizontal: altura manda
              h = pos === 's' ? Math.max(MIN, ini.h + dy) : Math.max(MIN, ini.h - dy);
              w = h * razao;
              x = ini.x + (ini.w - w) / 2; // centraliza
              if (pos === 'n') y = ini.y + ini.h - h;
            } else {
              h = w / razao;
              if (pos.includes('n')) y = ini.y + ini.h - h;
            }
          } else {
            if (pos.includes('s')) { h = Math.max(MIN, ini.h + dy); }
            if (pos.includes('n')) { h = Math.max(MIN, ini.h - dy); y = ini.y + ini.h - h; }
          }

          // Prende dentro do vídeo
          w = Math.min(w, 1); h = Math.min(h, 1);
          x = Math.min(1 - w, Math.max(0, x));
          y = Math.min(1 - h, Math.max(0, y));
          Object.assign(r, { x, y, w, h });

          const el = document.querySelector(`#camada-regioes .regiao[data-idx="${i}"]`);
          if (el) this.posicionarEl(el, r);
          this.salvarEstado();
        },
      },
    });
  },

  // --------------------------------------------------------------------------
  // Camadas (lista lateral)
  // --------------------------------------------------------------------------

  desenharCamadas() {
    const ul = document.getElementById('lista-camadas');
    ul.innerHTML = '';
    const slots = this.slotsAtuais();
    this.estado.regioes.forEach((r, i) => {
      const li = document.createElement('li');
      li.className = 'camada';
      li.dataset.idx = i;
      const semSlot = r.slot < 0 || r.slot >= slots.length;
      li.innerHTML = `
        <span class="alca-ordem" title="Arrastar para reordenar">⠿</span>
        <span class="cor-ponto" style="background:${r.cor}"></span>
        <input class="nome-camada" value="${esc(r.nome)}" maxlength="24"
               title="${semSlot ? 'Sem slot neste layout (não aparece na saída)' : `Slot ${r.slot + 1}`}">
        <button class="icone-btn btn-trava" title="${r.travada ? 'Destravar' : 'Travar'}">${r.travada ? '🔒' : '🔓'}</button>
        <button class="icone-btn perigo btn-excluir" title="Excluir">🗑</button>`;
      if (semSlot) li.style.opacity = '.55';

      li.querySelector('.nome-camada').addEventListener('change', (e) => {
        r.nome = e.target.value.trim().slice(0, 24) || r.nome;
        this.montarRegioes();
        this.salvarEstado();
      });
      li.querySelector('.btn-trava').addEventListener('click', () => {
        r.travada = !r.travada;
        this.montarRegioes();
        this.desenharCamadas();
        this.salvarEstado();
      });
      li.querySelector('.btn-excluir').addEventListener('click', () => {
        this.estado.regioes.splice(i, 1);
        this.compactarSlots();
        this.regiaoSel = 0;
        this.montarRegioes();
        this.desenharCamadas();
        this.salvarEstado();
        this.atualizarBtnAdd();
      });
      ul.appendChild(li);
      this.tornarReordenavel(li);
    });
  },

  /** Reordena camadas arrastando pela alça (interact.js, eixo Y) */
  tornarReordenavel(li) {
    let arrastando = false;
    interact(li).draggable({
      allowFrom: '.alca-ordem',
      modifiers: [interact.modifiers.restrictRect({ restriction: '#lista-camadas' })],
      listeners: {
        start: () => { arrastando = true; li.classList.add('arrastando'); },
        move: (e) => {
          const y = (parseFloat(li.dataset.y || 0)) + e.dy;
          li.dataset.y = y;
          li.style.transform = `translateY(${y}px)`;
          // Troca de lugar com o item sob o ponteiro
          li.style.pointerEvents = 'none';
          const sob = document.elementFromPoint(e.clientX, e.clientY)?.closest('.camada');
          li.style.pointerEvents = '';
          const ul = document.getElementById('lista-camadas');
          if (sob && sob !== li) {
            const itens = [...ul.children];
            if (itens.indexOf(sob) > itens.indexOf(li)) ul.insertBefore(li, sob.nextSibling);
            else ul.insertBefore(li, sob);
          }
        },
        end: () => {
          li.classList.remove('arrastando');
          li.style.transform = '';
          li.dataset.y = 0;
          if (!arrastando) return;
          arrastando = false;
          // A ordem do DOM vira a ordem dos slots
          const ul = document.getElementById('lista-camadas');
          const nova = [...ul.children].map((el) => this.estado.regioes[Number(el.dataset.idx)]);
          this.estado.regioes = nova;
          this.compactarSlots();
          this.regiaoSel = 0;
          this.montarRegioes();
          this.desenharCamadas();
          this.salvarEstado();
        },
      },
    });
  },

  /** Slots 0..N em ordem; excedentes ficam com slot -1 */
  compactarSlots() {
    const n = this.slotsAtuais().length;
    this.estado.regioes.forEach((r, i) => { r.slot = i < n ? i : -1; });
  },

  /** Adiciona região (máx. 3 e no máximo 1 por slot do layout atual) */
  adicionarRegiao() {
    const st = this.estado;
    const n = this.slotsAtuais().length;
    if (st.regioes.length >= 3 || st.regioes.length >= n) {
      toast(n < 3
        ? 'Este layout já está cheio. Troque de layout para ter mais slots.'
        : 'Máximo de 3 regiões por clipe.', 'erro');
      return;
    }
    const usados = new Set(st.regioes.map((r) => r.slot));
    const slotLivre = [...Array(n).keys()].find((s) => !usados.has(s)) ?? 0;
    const vw = this.video.videoWidth || 1280, vh = this.video.videoHeight || 720;
    const nomes = ['Principal', 'Webcam', 'Extra'];
    st.regioes.push({
      nome: nomes[st.regioes.length] || `Região ${st.regioes.length + 1}`,
      cor: CORES_REGIAO[st.regioes.length % CORES_REGIAO.length],
      slot: slotLivre,
      travada: false,
      ...this.encaixarNoSlot(this.slotsAtuais()[slotLivre], vw, vh, 0.5, 0.5),
    });
    this.regiaoSel = st.regioes.length - 1;
    this.montarRegioes();
    this.desenharCamadas();
    this.salvarEstado();
    this.atualizarBtnAdd();
  },

  atualizarBtnAdd() {
    const n = this.slotsAtuais().length;
    document.getElementById('btn-add-regiao').disabled =
      this.estado.regioes.length >= Math.min(3, n);
  },

  // --------------------------------------------------------------------------
  // Preview de saída (canvas em tempo real)
  // --------------------------------------------------------------------------

  iniciarLoop() {
    cancelAnimationFrame(this._raf);
    const quadro = () => {
      if (!this.aberto) return;
      this.desenharSaida();
      Timeline.atualizar();
      this._raf = requestAnimationFrame(quadro);
    };
    this._raf = requestAnimationFrame(quadro);
  },

  desenharSaida() {
    const ctx = this.ctx, v = this.video;
    if (!ctx || !v || v.readyState < 2) return;
    const W = this.canvas.width, H = this.canvas.height; // 360×640
    const st = this.estado;
    const k = W / 1080; // fator de escala do espaço de saída

    // --- Fundo ---
    if (st.fundo === 'desfocado') {
      ctx.save();
      ctx.filter = 'blur(14px) brightness(0.55) saturate(1.3)';
      // Cobre tudo (contain→cover manual)
      const ev = v.videoWidth / v.videoHeight, ec = W / H;
      let dw, dh;
      if (ev > ec) { dh = H; dw = H * ev; } else { dw = W; dh = W / ev; }
      ctx.drawImage(v, (W - dw) / 2, (H - dh) / 2, dw, dh);
      ctx.restore();
    } else {
      ctx.fillStyle = st.fundo === 'cor' ? st.fundoCor : '#000';
      ctx.fillRect(0, 0, W, H);
    }

    // --- Regiões empilhadas nos slots ---
    const slots = this.slotsAtuais();
    const vw = v.videoWidth, vh = v.videoHeight;
    const ordenadas = [...st.regioes]
      .filter((r) => r.slot >= 0 && r.slot < slots.length)
      .sort((a, b) => a.slot - b.slot);

    for (const r of ordenadas) {
      const s = slots[r.slot];
      const sx = r.x * vw, sy = r.y * vh, sw = Math.max(1, r.w * vw), sh = Math.max(1, r.h * vh);
      let dx = s.x * k, dy = s.y * k, dw = s.w * k, dh = s.h * k;
      if (st.ajuste === 'conter') {
        // Cabe inteiro no slot (letterbox com o fundo aparecendo)
        const f = Math.min(dw / sw, dh / sh);
        const w2 = sw * f, h2 = sh * f;
        dx += (dw - w2) / 2; dy += (dh - h2) / 2; dw = w2; dh = h2;
      }
      ctx.save();
      if (s.pip) {
        // Cantos arredondados no picture-in-picture (com fallback para rect)
        const raio = (s.raio || 32) * k;
        const caminho = () => {
          ctx.beginPath();
          if (typeof ctx.roundRect === 'function') ctx.roundRect(dx, dy, dw, dh, raio);
          else ctx.rect(dx, dy, dw, dh);
        };
        caminho();
        ctx.clip();
        ctx.drawImage(v, sx, sy, sw, sh, dx, dy, dw, dh);
        ctx.strokeStyle = 'rgba(255,255,255,.85)';
        ctx.lineWidth = 3;
        caminho();
        ctx.stroke();
      } else {
        ctx.drawImage(v, sx, sy, sw, sh, dx, dy, dw, dh);
      }
      ctx.restore();
    }

    // --- Headline flutuante (Anton, contorno preto, sombra dura, sem faixa) ---
    const hl = st.headline;
    if (hl && hl.texto.trim()) {
      const txt = hl.texto.trim().slice(0, 60);
      let fsPx = (hl.tamanho || 84) * k; // px no canvas
      // Encolhe para caber na largura (igual ao enviado na compilação)
      ctx.save();
      const aplicarFonte = (px) => { ctx.font = `${px}px Anton, 'Arial Black', sans-serif`; };
      aplicarFonte(fsPx);
      const maxL = W - 24;
      const medido = ctx.measureText(txt).width;
      if (medido > maxL) fsPx = Math.max(8, fsPx * (maxL / medido));
      aplicarFonte(fsPx);
      this._hlFontePx = Math.round(fsPx / k); // tamanho efetivo (espaço 1080)
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = Math.max(2, fsPx * 0.11);
      ctx.strokeStyle = '#000';
      ctx.shadowColor = 'rgba(0,0,0,.9)';
      ctx.shadowBlur = 0; // sombra dura, sem desfoque
      ctx.shadowOffsetX = fsPx * 0.05;
      ctx.shadowOffsetY = fsPx * 0.05;
      const cy = this.headlineY() * k;
      ctx.strokeText(txt, W / 2, cy);
      ctx.fillStyle = '#fff';
      ctx.fillText(txt, W / 2, cy);
      ctx.restore();
    }
  },

  // --------------------------------------------------------------------------
  // Transporte (play / pause / seek)
  // --------------------------------------------------------------------------

  togglePlay() {
    const v = this.video;
    if (!v) return;
    if (v.paused) {
      // Se estava no fim da seleção, recomeça do início
      if (v.currentTime >= this.estado.fim - 0.05) v.currentTime = this.estado.inicio;
      v.play().catch(() => toast('Não consegui reproduzir o vídeo.', 'erro'));
    } else {
      v.pause();
    }
  },

  toggleMute() {
    const v = this.video;
    v.muted = !v.muted;
    Timeline.atualizar();
  },

  buscar(t) {
    const dur = this.clip?.duracao || this.video.duration || 0;
    this.video.currentTime = Math.min(dur, Math.max(0, t));
    Timeline.atualizar();
  },

  passarFrame(dir) {
    const fps = this.clip?.fps || 30;
    this.buscar(this.video.currentTime + (dir / fps));
  },

  // --------------------------------------------------------------------------
  // Zoom da entrada + painel de configurações + modal de layouts
  // --------------------------------------------------------------------------

  aplicarZoom() {
    const v = this.video;
    if (!v?.videoWidth) return;
    const scroll = document.getElementById('entrada-scroll');
    const fit = Math.min(
      (scroll.clientWidth - 24) / v.videoWidth,
      (scroll.clientHeight - 24) / v.videoHeight
    );
    const s = fit * this.zoom;
    const palco = this.palco();
    palco.style.width = `${Math.round(v.videoWidth * s)}px`;
    palco.style.height = `${Math.round(v.videoHeight * s)}px`;
    document.getElementById('zoom-valor').textContent = `${Math.round(this.zoom * 100)}%`;
  },

  mudarZoom(fator) {
    this.zoom = Math.min(2, Math.max(0.25, this.zoom * fator));
    this.aplicarZoom();
  },

  sincronizarPainelConfigs() {
    const st = this.estado;
    document.querySelector(`input[name="fundo"][value="${st.fundo}"]`).checked = true;
    document.getElementById('cfg-fundo-cor').value = st.fundoCor || '#121218';
    document.querySelector(`input[name="ajuste"][value="${st.ajuste}"]`).checked = true;
    document.getElementById('cfg-audio').checked = st.audio !== false;
    document.getElementById('cfg-audio-rotulo').textContent = st.audio !== false ? 'Áudio ligado' : 'Áudio desligado';
    document.getElementById('cfg-volume').value = st.volume ?? 100;
    document.getElementById('cfg-volume-valor').textContent = `${st.volume ?? 100}%`;
    document.getElementById('cfg-trava-proporcao').checked = st.travaProporcao !== false;
    document.getElementById('cfg-headline-texto').value = st.headline?.texto || '';
    document.getElementById('cfg-headline-tamanho').value = st.headline?.tamanho || 84;
    document.getElementById('cfg-headline-tamanho-valor').textContent = `${st.headline?.tamanho || 84}`;
    const hlY = Number.isFinite(Number(st.headline?.y)) ? Number(st.headline.y) : headlineYPadrao(this.slotsAtuais());
    document.getElementById('cfg-headline-y').value = hlY;
    document.getElementById('cfg-headline-y-valor').textContent = `${hlY}`;
  },

  abrirModalLayout() {
    const grade = document.getElementById('grade-layouts');
    grade.innerHTML = '';
    for (const [id, lay] of Object.entries(LAYOUTS)) {
      const card = document.createElement('div');
      card.className = 'layout-card' + (this.estado.layout === id ? ' ativo' : '');
      card.innerHTML = `<div class="layout-mini">${this.miniLayout(lay)}</div>
        <strong>${lay.nome}</strong><p>${lay.desc}</p>`;
      card.addEventListener('click', () => {
        if (id === 'personalizado') {
          document.getElementById('layout-personalizado').hidden = false;
          this.iniciarDivisoria();
        } else {
          document.getElementById('layout-personalizado').hidden = true;
          this.aplicarLayout(id);
          this.marcarLayoutAtivo();
        }
      });
      card.dataset.layout = id;
      grade.appendChild(card);
    }
    document.getElementById('layout-personalizado').hidden = this.estado.layout !== 'personalizado';
    if (this.estado.layout === 'personalizado') this.iniciarDivisoria();
    abrirModal('modal-layout');
  },

  /** Miniatura do preset (barrinhas proporcionais aos slots) */
  miniLayout(lay) {
    if (lay.mini === 'pip') {
      return `<div class="lm destaque"></div>`;
    }
    return lay.mini.map((m) => `<div class="lm" style="flex:${m.f}"></div>`).join('');
  },

  marcarLayoutAtivo() {
    document.querySelectorAll('.layout-card').forEach((c) => {
      c.classList.toggle('ativo', c.dataset.layout === this.estado.layout);
    });
    this.atualizarBtnAdd();
  },

  /** Demo arrastável da divisória do layout personalizado */
  iniciarDivisoria() {
    const demo = document.getElementById('lp-demo');
    const div = document.getElementById('lp-div');
    const a = document.getElementById('lp-slot-a');
    const b = document.getElementById('lp-slot-b');
    const desenhar = () => {
      const d = this.estado.layout === 'personalizado' ? this.estado.divisao : 0.6;
      a.style.flex = d;
      b.style.flex = 1 - d;
      div.style.top = `${d * 100}%`;
      document.getElementById('lp-valor').textContent =
        `${Math.round(d * 100)}% / ${Math.round((1 - d) * 100)}%`;
    };
    desenhar();
    interact(div).draggable({
      listeners: {
        move: (e) => {
          const r = demo.getBoundingClientRect();
          const d = Math.min(0.8, Math.max(0.2, (e.clientY - r.top) / r.height));
          this.aplicarLayout('personalizado', Math.round(d * 100) / 100);
          desenhar();
        },
      },
    });
  },

  // --------------------------------------------------------------------------
  // Persistência (salva o estado do editor no backend, com debounce)
  // --------------------------------------------------------------------------

  salvarEstado() {
    clearTimeout(this._salvarTimer);
    this._salvarTimer = setTimeout(async () => {
      if (!this.aberto || !this.clip) return;
      try {
        await api(`/api/clips/${this.clip.id}`, { method: 'PATCH', body: { editor: this.estado } });
      } catch { /* silencioso: o essencial já está na tela */ }
    }, 800);
  },
};

// ----------------------------------------------------------------------------
// Eventos fixos do editor (registrados uma vez)
// ----------------------------------------------------------------------------
(() => {
  document.getElementById('btn-add-regiao').addEventListener('click', () => Editor.adicionarRegiao());
  document.getElementById('btn-layout').addEventListener('click', () => Editor.abrirModalLayout());
  document.getElementById('btn-compilar').addEventListener('click', () => Compilar.abrir());
  document.getElementById('bc-voltar').addEventListener('click', (e) => {
    e.preventDefault();
    location.hash = '#/';
  });

  // Seletor de modo Ambos | Entrada | Saída
  document.querySelectorAll('.modo-seletor button').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.modo-seletor button').forEach((b) => b.classList.remove('ativo'));
      btn.classList.add('ativo');
      const palcos = document.querySelector('.palcos');
      palcos.classList.remove('modo-entrada', 'modo-saida');
      if (btn.dataset.modo === 'entrada') palcos.classList.add('modo-entrada');
      if (btn.dataset.modo === 'saida') palcos.classList.add('modo-saida');
      Editor.aplicarZoom();
    });
  });

  // Zoom
  document.getElementById('zoom-mais').addEventListener('click', () => Editor.mudarZoom(1.25));
  document.getElementById('zoom-menos').addEventListener('click', () => Editor.mudarZoom(1 / 1.25));
  document.getElementById('zoom-ajustar').addEventListener('click', () => { Editor.zoom = 1; Editor.aplicarZoom(); });
  window.addEventListener('resize', () => { if (Editor.aberto) Editor.aplicarZoom(); });

  // Abas Camadas | Configurações
  document.querySelectorAll('.abas button').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.abas button').forEach((b) => b.classList.remove('ativo'));
      btn.classList.add('ativo');
      document.getElementById('aba-camadas').hidden = btn.dataset.aba !== 'camadas';
      document.getElementById('aba-configs').hidden = btn.dataset.aba !== 'configs';
    });
  });

  // Configurações: fundo / ajuste / áudio / volume / trava de proporção
  document.querySelectorAll('input[name="fundo"]').forEach((r) => {
    r.addEventListener('change', () => { Editor.estado.fundo = r.value; Editor.salvarEstado(); });
  });
  document.getElementById('cfg-fundo-cor').addEventListener('input', (e) => {
    Editor.estado.fundoCor = e.target.value;
    Editor.estado.fundo = 'cor';
    document.querySelector('input[name="fundo"][value="cor"]').checked = true;
    Editor.salvarEstado();
  });
  document.querySelectorAll('input[name="ajuste"]').forEach((r) => {
    r.addEventListener('change', () => { Editor.estado.ajuste = r.value; Editor.salvarEstado(); });
  });
  document.getElementById('cfg-audio').addEventListener('change', (e) => {
    Editor.estado.audio = e.target.checked;
    document.getElementById('cfg-audio-rotulo').textContent = e.target.checked ? 'Áudio ligado' : 'Áudio desligado';
    Editor.salvarEstado();
  });
  document.getElementById('cfg-volume').addEventListener('input', (e) => {
    Editor.estado.volume = Number(e.target.value);
    Editor.video.volume = Editor.estado.volume / 100;
    document.getElementById('cfg-volume-valor').textContent = `${e.target.value}%`;
    Editor.salvarEstado();
  });
  document.getElementById('cfg-trava-proporcao').addEventListener('change', (e) => {
    Editor.estado.travaProporcao = e.target.checked;
    Editor.salvarEstado();
  });

  // Headline: texto vazio = desativada (posição Y não mexe nos slots)
  const hlTexto = document.getElementById('cfg-headline-texto');
  const hlTam = document.getElementById('cfg-headline-tamanho');
  const hlY = document.getElementById('cfg-headline-y');
  let hlTimer = null;
  const hlAtivaAntes = () => !!(Editor.estado.headline?.texto.trim());
  hlTexto.addEventListener('input', () => {
    const antes = hlAtivaAntes();
    Editor.estado.headline.texto = hlTexto.value.slice(0, 60);
    if (Editor.estado.headline.y == null) {
      Editor.estado.headline.y = Editor.headlineY();
      hlY.value = Editor.estado.headline.y;
      document.getElementById('cfg-headline-y-valor').textContent = `${Editor.estado.headline.y}`;
    }
    clearTimeout(hlTimer);
    hlTimer = setTimeout(() => {
      // Reajusta as regiões só na transição liga/desliga (não a cada letra)
      if (hlAtivaAntes() !== antes) Editor.aplicarHeadline();
      else Editor.salvarEstado();
    }, 500);
  });
  hlTam.addEventListener('input', () => {
    Editor.estado.headline.tamanho = Number(hlTam.value);
    document.getElementById('cfg-headline-tamanho-valor').textContent = hlTam.value;
    Editor.salvarEstado(); // tamanho não muda os slots: preview atualiza sozinho
  });
  hlY.addEventListener('input', () => {
    Editor.estado.headline.y = Number(hlY.value);
    document.getElementById('cfg-headline-y-valor').textContent = hlY.value;
    Editor.salvarEstado(); // posição não muda os slots: preview atualiza sozinho
  });
})();
