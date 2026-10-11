/* ============================================================================
   api.js — Camada de comunicação com o backend + utilitários de UI
============================================================================ */
'use strict';

/** Requisição JSON com tratamento de erro amigável */
async function api(caminho, opcoes = {}) {
  let resp;
  try {
    resp = await fetch(caminho, {
      headers: opcoes.corpoFormData ? undefined : { 'Content-Type': 'application/json' },
      ...opcoes,
      body: opcoes.corpoFormData ? opcoes.body : (opcoes.body ? JSON.stringify(opcoes.body) : undefined),
    });
  } catch {
    throw new Error('Não consegui falar com o servidor. Ele está rodando?');
  }
  let dados = null;
  try { dados = await resp.json(); } catch { /* resposta sem JSON */ }
  if (!resp.ok) {
    throw new Error(dados?.erro || 'Algo deu errado. Tente novamente.');
  }
  return dados;
}

/** Mostra uma mensagem flutuante (toast) */
function toast(msg, tipo = 'info', ms = 4200) {
  const caixa = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = `toast ${tipo}`;
  el.textContent = msg;
  caixa.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; }, ms - 300);
  setTimeout(() => el.remove(), ms);
}

/** Formata segundos como 00:02.33 */
function fmtTempo(seg) {
  seg = Math.max(0, seg || 0);
  const m = Math.floor(seg / 60);
  const s = seg % 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
}

/** Formata duração curta: 0:32 */
function fmtDur(seg) {
  seg = Math.max(0, Math.round(seg || 0));
  return `${Math.floor(seg / 60)}:${String(seg % 60).padStart(2, '0')}`;
}

/** Data amigável: "10 de out., 14:32" */
function fmtData(ts) {
  return new Date(ts).toLocaleString('pt-BR', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
  });
}

/** Abre/fecha modais */
function abrirModal(id) { document.getElementById(id).hidden = false; }
function fecharModal(id) { document.getElementById(id).hidden = true; }

// Fecha modais ao clicar no fundo ou no botão ✕
document.addEventListener('click', (e) => {
  if (e.target.classList?.contains('modal')) e.target.hidden = true;
  if (e.target.matches('[data-fechar]')) e.target.closest('.modal').hidden = true;
});

/** Escapa HTML (segurança básica ao inserir títulos vindos da Kick) */
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
