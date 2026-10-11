/* ============================================================================
   compilar.js — Modal "Compilar": título, FPS, qualidade, progresso via SSE
   e tela de conclusão (player, baixar, copiar link, editar novamente).
============================================================================ */
'use strict';

const Compilar = {
  jobId: null,
  fonteEventos: null,

  abrir() {
    if (!Editor.clip || !Editor.estado) return toast('Abra um clipe primeiro.', 'erro');
    const st = Editor.estado;
    const dur = st.fim - st.inicio;
    if (dur <= 0.1) return toast('Selecione um trecho na timeline (I = início, O = fim).', 'erro');

    // Passo 1: formulário
    document.getElementById('comp-form').hidden = false;
    document.getElementById('comp-progresso').hidden = true;
    document.getElementById('comp-pronto').hidden = true;
    const titulo = document.getElementById('comp-titulo');
    titulo.value = Editor.clip.titulo || '';
    this.atualizarContador();
    document.getElementById('comp-erro').hidden = true;
    abrirModal('modal-compilar');
    setTimeout(() => titulo.focus(), 50);
  },

  atualizarContador() {
    document.getElementById('comp-contador').textContent =
      document.getElementById('comp-titulo').value.length;
  },

  async iniciar() {
    const st = Editor.estado;
    const titulo = document.getElementById('comp-titulo').value.trim();
    const fps = Number(document.getElementById('comp-fps').value);
    const quality = Number(document.getElementById('comp-qualidade').value);
    const erroEl = document.getElementById('comp-erro');
    erroEl.hidden = true;

    if (!titulo) {
      erroEl.textContent = 'Dê um título ao seu clipe.';
      erroEl.hidden = false;
      return;
    }

    // Regiões com slot válido (ordem dos slots) + slots em pixels de saída
    const slots = Editor.slotsAtuais();
    const regioes = st.regioes
      .filter((r) => r.slot >= 0 && r.slot < slots.length)
      .sort((a, b) => a.slot - b.slot)
      .map((r) => ({
        x: +r.x.toFixed(4), y: +r.y.toFixed(4),
        w: +r.w.toFixed(4), h: +r.h.toFixed(4),
        slot: r.slot,
      }));
    if (!regioes.length) {
      erroEl.textContent = 'Nenhuma região visível neste layout. Adicione uma região.';
      erroEl.hidden = false;
      return;
    }

    const btn = document.getElementById('btn-iniciar-compilacao');
    btn.disabled = true;
    btn.textContent = 'Enviando…';
    // Headline flutuante: tamanho efetivo do preview + Y escolhido.
    // Os slots vão inteiros (sem faixa).
    const hlTexto = (st.headline?.texto || '').trim().slice(0, 60);
    const headline = hlTexto ? {
      texto: hlTexto,
      tamanho: Math.min(160, Math.max(30, Editor._hlFontePx || st.headline.tamanho || 84)),
      y: Math.round(Editor.headlineY()),
    } : null;
    try {
      const { job } = await api('/api/render', {
        method: 'POST',
        body: {
          clipId: Editor.clip.id,
          start: +st.inicio.toFixed(3),
          end: +st.fim.toFixed(3),
          layout: st.layout,
          divisao: st.divisao,
          regions: regioes,
          slots,
          fps,
          quality,
          title: titulo.slice(0, 140),
          background: { modo: st.fundo, cor: st.fundoCor },
          ajuste: st.ajuste,
          audio: st.audio !== false,
          volume: st.volume ?? 100,
          headline,
        },
      });
      this.jobId = job.id;
      this.mostrarProgresso();
      this.acompanhar(job.id);
    } catch (e) {
      erroEl.textContent = e.message;
      erroEl.hidden = false;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Iniciar compilação';
    }
  },

  mostrarProgresso() {
    document.getElementById('comp-form').hidden = true;
    document.getElementById('comp-progresso').hidden = false;
    document.getElementById('comp-pronto').hidden = true;
    document.getElementById('prog-preench').style.width = '0%';
    document.getElementById('prog-pct').textContent = '0%';
    document.getElementById('prog-eta').textContent = 'calculando…';
  },

  /** Acompanha o job via SSE (progresso real vindo do ffmpeg) */
  acompanhar(jobId) {
    this.fecharEventos();
    const es = new EventSource(`/api/render/${jobId}/events`);
    this.fonteEventos = es;

    es.addEventListener('progresso', (e) => {
      const d = JSON.parse(e.data);
      document.getElementById('prog-preench').style.width = `${d.progresso}%`;
      document.getElementById('prog-pct').textContent = `${d.progresso}%`;
      document.getElementById('prog-eta').textContent = d.eta || 'calculando…';
      Biblioteca.carregar();
    });
    es.addEventListener('pronto', (e) => {
      const d = JSON.parse(e.data);
      this.fecharEventos();
      this.mostrarPronto(d);
      Biblioteca.carregar();
    });
    es.addEventListener('erro', (e) => {
      const d = JSON.parse(e.data);
      this.fecharEventos();
      toast(d.erro || 'Falha na compilação.', 'erro', 8000);
      // Volta ao formulário para tentar de novo
      document.getElementById('comp-form').hidden = false;
      document.getElementById('comp-progresso').hidden = true;
      Biblioteca.carregar();
    });
    es.onerror = () => {
      // SSE caiu: o job continua no servidor; o card mostra o progresso
      this.fecharEventos();
      toast('Conexão de progresso perdida — o clipe continua compilando. Acompanhe em "Meus clipes".', 'erro', 6000);
      fecharModal('modal-compilar');
      Biblioteca.carregar();
    };
  },

  mostrarPronto(d) {
    document.getElementById('comp-form').hidden = true;
    document.getElementById('comp-progresso').hidden = true;
    document.getElementById('comp-pronto').hidden = false;
    const video = document.getElementById('video-final');
    video.src = `/media/${Editor.clip.id}/saida.mp4?t=${Date.now()}`;
    const baixar = document.getElementById('btn-baixar');
    baixar.href = `/api/clips/${Editor.clip.id}/download`;
    // Atualiza o registro local (título pode ter mudado)
    api(`/api/clips/${Editor.clip.id}`, { method: 'PATCH', body: { titulo: document.getElementById('comp-titulo').value.trim() } })
      .catch(() => {});
    Biblioteca.carregar();
  },

  async cancelar() {
    if (!this.jobId) return fecharModal('modal-compilar');
    try {
      await api(`/api/render/${this.jobId}`, { method: 'DELETE' });
      toast('Compilação cancelada.', 'ok');
    } catch (e) {
      toast(e.message, 'erro');
    } finally {
      this.fecharEventos();
      fecharModal('modal-compilar');
      Biblioteca.carregar();
    }
  },

  fecharEventos() {
    if (this.fonteEventos) { this.fonteEventos.close(); this.fonteEventos = null; }
  },

  copiarLink() {
    const url = `${location.origin}/media/${Editor.clip.id}/saida.mp4`;
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(url)
        .then(() => toast('Link local copiado!', 'ok'))
        .catch(() => prompt('Copie o link:', url));
    } else {
      prompt('Copie o link:', url);
    }
  },
};

// ----------------------------------------------------------------------------
// Eventos do modal
// ----------------------------------------------------------------------------
(() => {
  document.getElementById('comp-titulo').addEventListener('input', () => Compilar.atualizarContador());
  document.getElementById('btn-iniciar-compilacao').addEventListener('click', () => Compilar.iniciar());
  document.getElementById('btn-cancelar-compilacao').addEventListener('click', () => Compilar.cancelar());
  document.getElementById('btn-copiar-link').addEventListener('click', () => Compilar.copiarLink());
  document.getElementById('btn-editar-novamente').addEventListener('click', () => fecharModal('modal-compilar'));
  // Fechar o modal não cancela o job — ele continua no servidor
  document.getElementById('modal-compilar').addEventListener('click', (e) => {
    if (e.target.classList.contains('modal')) Compilar.fecharEventos();
  });
})();
