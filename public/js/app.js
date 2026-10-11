/* ============================================================================
   app.js — Inicialização e roteamento (#/ ↔ #/editor/:id)
============================================================================ */
'use strict';

window.FREECLIP_CFG = { maxClipMinutes: 3 };

/** Alterna entre biblioteca e editor conforme o hash */
async function rotear() {
  const m = location.hash.match(/^#\/editor\/([a-f0-9]+)/);
  if (m) {
    await Editor.abrir(m[1]);
  } else {
    if (Editor.aberto) Editor.fechar();
    else {
      document.getElementById('view-editor').hidden = true;
      document.getElementById('view-biblioteca').hidden = false;
    }
    Biblioteca.carregar();
  }
}

window.addEventListener('hashchange', rotear);

(async function init() {
  // Config e saúde do backend (encoder ativo, limites)
  try {
    const saude = await api('/api/health');
    window.FREECLIP_CFG.maxClipMinutes = saude.config?.maxClipMinutes || 3;
    const enc = saude.encoder;
    document.getElementById('encoder-info').textContent =
      enc ? `⚙ ${enc.nome}` : '';
    const limiteMB = saude.config?.maxUploadMB || 2048;
    document.getElementById('dropzone-limite').textContent =
      limiteMB >= 1024 ? `${(limiteMB / 1024).toFixed(limiteMB % 1024 ? 1 : 0)} GB` : `${limiteMB} MB`;
    if (!saude.ok) {
      toast(`Faltando: ${(saude.faltando || []).join(', ')}. Veja o terminal do servidor.`, 'erro', 8000);
    }
  } catch {
    toast('Não consegui falar com o servidor. Rode "npm start" e recarregue.', 'erro', 9000);
  }
  rotear();
})();
