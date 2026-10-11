/* ============================================================================
   biblioteca.js — Tela "Meus clipes": grade de cards + modal "Criar clipe"
============================================================================ */
'use strict';

const Biblioteca = {
  clips: [],
  timerPoll: null,

  async carregar() {
    try {
      const { clips } = await api('/api/clips');
      this.clips = clips;
      this.desenhar();
      this.agendarPoll();
    } catch (e) {
      toast(e.message, 'erro');
    }
  },

  /** Enquanto houver clipe baixando/processando, atualiza a cada 1 s */
  agendarPoll() {
    clearTimeout(this.timerPoll);
    if (this.clips.some((c) => c.status === 'baixando' || c.status === 'processando' || c.status === 'compilando')) {
      this.timerPoll = setTimeout(() => this.carregar(), 1000);
    }
  },

  desenhar() {
    const grade = document.getElementById('grade-clipes');
    document.getElementById('bib-vazio').hidden = this.clips.length > 0;
    grade.innerHTML = '';

    for (const clip of this.clips) {
      const card = document.createElement('div');
      card.className = 'card';

      const pronto = clip.status === 'pronto';
      const baixando = clip.status === 'baixando' || clip.status === 'processando';
      const compilando = clip.status === 'compilando';
      const erro = clip.status === 'erro';

      // Thumb com overlay de status
      const thumb = document.createElement('div');
      thumb.className = 'card-thumb';
      if (pronto || compilando || clip.saida) {
        thumb.style.backgroundImage = `url('/media/${clip.id}/thumb.jpg')`;
      }
      if (baixando || compilando) {
        thumb.innerHTML = `
          <div class="card-status">
            <span>${baixando ? 'Obtendo clipe…' : 'compilando…'}</span>
            <div class="barra"><div style="width:${Math.round(clip.progresso || 0)}%"></div></div>
          </div>`;
      } else if (erro) {
        thumb.innerHTML = `
          <div class="card-status erro">
            <span>⚠ Erro</span>
            <span class="msg">${esc(clip.erro || 'Falha desconhecida.')}</span>
          </div>`;
      } else {
        thumb.innerHTML = `<span class="dur">${fmtDur(clip.duracao)}</span>`;
      }
      thumb.addEventListener('click', () => {
        if (erro) return toast(clip.erro || 'Este clipe falhou.', 'erro');
        location.hash = `#/editor/${clip.id}`;
      });

      card.appendChild(thumb);

      // Título editável (clique para renomear), data
      const info = document.createElement('div');
      info.className = 'card-info';
      info.innerHTML = `
        <input class="card-titulo" value="${esc(clip.titulo)}" maxlength="140" title="Clique para renomear">
        <span class="card-data">${fmtData(clip.criadoEm)}</span>`;
      info.querySelector('.card-titulo').addEventListener('change', async (e) => {
        const novo = e.target.value.trim();
        if (!novo || novo === clip.titulo) { e.target.value = clip.titulo; return; }
        try {
          await api(`/api/clips/${clip.id}`, { method: 'PATCH', body: { titulo: novo } });
          clip.titulo = novo;
          toast('Clipe renomeado.', 'ok');
        } catch (err) { toast(err.message, 'erro'); e.target.value = clip.titulo; }
      });
      card.appendChild(info);

      // Ações: abrir / baixar / excluir
      const acoes = document.createElement('div');
      acoes.className = 'card-acoes';

      const btnAbrir = document.createElement('button');
      btnAbrir.className = 'btn-mini';
      btnAbrir.textContent = 'Abrir';
      btnAbrir.onclick = () => { location.hash = `#/editor/${clip.id}`; };

      const btnBaixar = document.createElement('a');
      btnBaixar.className = 'btn-mini';
      btnBaixar.textContent = 'Baixar';
      if (clip.saida) {
        btnBaixar.href = `/api/clips/${clip.id}/download`;
      } else {
        btnBaixar.setAttribute('disabled', '');
        btnBaixar.title = 'Compile o clipe primeiro';
      }

      const btnExcluir = document.createElement('button');
      btnExcluir.className = 'btn-mini perigo';
      btnExcluir.textContent = 'Excluir';
      btnExcluir.onclick = async () => {
        if (!confirm(`Excluir "${clip.titulo}"? Isso apaga os arquivos do disco.`)) return;
        try {
          await api(`/api/clips/${clip.id}`, { method: 'DELETE' });
          this.clips = this.clips.filter((c) => c.id !== clip.id);
          this.desenhar();
          toast('Clipe excluído.', 'ok');
        } catch (e) { toast(e.message, 'erro'); }
      };

      acoes.append(btnAbrir, btnBaixar, btnExcluir);
      card.appendChild(acoes);
      grade.appendChild(card);
    }
  },
};

// ----------------------------------------------------------------------------
// Modal "Criar clipe"
// ----------------------------------------------------------------------------

async function abrirModalCriar() {
  document.getElementById('input-url').value = '';
  const erro = document.getElementById('criar-erro');
  erro.hidden = true;
  abrirModal('modal-criar');
  setTimeout(() => document.getElementById('input-url').focus(), 50);
}

function mostrarErroCriar(msg) {
  const el = document.getElementById('criar-erro');
  el.textContent = msg;
  el.hidden = false;
}

/** Resolve um link da Kick e leva ao editor quando o download terminar */
async function obterClipeDaKick() {
  const url = document.getElementById('input-url').value.trim();
  const btn = document.getElementById('btn-obter');
  if (!url) return mostrarErroCriar('Cole um link de clipe da Kick.');

  btn.disabled = true;
  btn.textContent = 'Obtendo…';
  try {
    const { clip } = await api('/api/clips/resolve', { method: 'POST', body: { url } });
    fecharModal('modal-criar');
    Biblioteca.carregar();
    await acompanharStatusEAirEditor(clip.id);
  } catch (e) {
    // Erro amigável já vem do backend; reforça a opção de upload
    mostrarErroCriar(e.message);
    document.getElementById('dropzone').style.borderColor = 'var(--rosa)';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Obter clipe';
  }
}

/** Acompanha o download; se der erro, avisa; se der certo, abre o editor */
async function acompanharStatusEAirEditor(id) {
  for (;;) {
    await new Promise((r) => setTimeout(r, 800));
    try {
      const { clip } = await api(`/api/clips/${id}`);
      Biblioteca.carregar();
      if (clip.status === 'pronto') {
        location.hash = `#/editor/${id}`;
        return;
      }
      if (clip.status === 'erro') {
        toast(clip.erro || 'Falha ao obter o clipe.', 'erro', 8000);
        return;
      }
    } catch { return; }
  }
}

/** Upload manual (dropzone ou clique para escolher) */
async function enviarArquivo(arquivo) {
  if (!arquivo) return;
  const btn = document.getElementById('btn-obter');
  const erro = document.getElementById('criar-erro');
  erro.hidden = true;

  const fd = new FormData();
  fd.append('arquivo', arquivo);
  btn.disabled = true;
  btn.textContent = 'Enviando…';
  try {
    const { clip } = await api('/api/clips/upload', { method: 'POST', body: fd, corpoFormData: true });
    fecharModal('modal-criar');
    Biblioteca.carregar();
    await acompanharStatusEAirEditor(clip.id);
  } catch (e) {
    mostrarErroCriar(e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Obter clipe';
  }
}

// ----------------------------------------------------------------------------
// Eventos da tela
// ----------------------------------------------------------------------------
document.getElementById('btn-criar').addEventListener('click', abrirModalCriar);
document.getElementById('btn-obter').addEventListener('click', obterClipeDaKick);
document.getElementById('input-url').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') obterClipeDaKick();
});
document.getElementById('btn-limpar-cache').addEventListener('click', async () => {
  try {
    const { removidos } = await api('/api/clips/limpar-cache', { method: 'POST' });
    toast(removidos ? `${removidos} clipe(s) antigo(s) removidos.` : 'Nada para limpar agora.', 'ok');
    Biblioteca.carregar();
  } catch (e) { toast(e.message, 'erro'); }
});

// Dropzone: arrastar e soltar + clique
(() => {
  const dz = document.getElementById('dropzone');
  const input = document.getElementById('input-arquivo');
  dz.addEventListener('click', () => input.click());
  dz.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.click(); });
  input.addEventListener('change', () => enviarArquivo(input.files[0]));
  for (const ev of ['dragenter', 'dragover']) {
    dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('sobre'); });
  }
  for (const ev of ['dragleave', 'drop']) {
    dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('sobre'); });
  }
  dz.addEventListener('drop', (e) => enviarArquivo(e.dataTransfer.files[0]));
})();
