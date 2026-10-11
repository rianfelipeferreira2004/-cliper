// ============================================================================
// store.js — Biblioteca de clipes persistida em JSON no disco (data/clips.json)
// ----------------------------------------------------------------------------
// Alternativa simples ao SQLite: um único JSON carregado em memória e
// salvo de forma atômica (arquivo temporário + rename) após cada mudança.
// ============================================================================
const fs = require('fs');
const path = require('path');
const cfg = require('./config');

let clips = []; // lista em memória

/** Carrega o JSON do disco (se existir) */
function carregar() {
  try {
    clips = JSON.parse(fs.readFileSync(cfg.DB_FILE, 'utf8'));
  } catch {
    clips = [];
  }
}

/** Salva de forma atômica: escreve em arquivo .tmp e renomeia */
function salvar() {
  const tmp = cfg.DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(clips, null, 2));
  fs.renameSync(tmp, cfg.DB_FILE);
}

function listar() {
  // Mais recentes primeiro
  return [...clips].sort((a, b) => b.criadoEm - a.criadoEm);
}

function obter(id) {
  return clips.find((c) => c.id === id) || null;
}

function adicionar(clip) {
  clips.push(clip);
  salvar();
  return clip;
}

function atualizar(id, patch) {
  const clip = obter(id);
  if (!clip) return null;
  Object.assign(clip, patch);
  salvar();
  return clip;
}

function remover(id) {
  const idx = clips.findIndex((c) => c.id === id);
  if (idx === -1) return false;
  clips.splice(idx, 1);
  salvar();
  // Remove a pasta de dados do clipe (vídeo, thumbs, saída)
  const dir = path.join(cfg.CLIPS_DIR, id);
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

/** Remove clipes com mais de N dias (limpeza automática) */
function limparAntigos(dias) {
  const limite = Date.now() - dias * 86400000;
  const antigos = clips.filter((c) => c.criadoEm < limite);
  for (const c of antigos) {
    console.log(`🧹 Limpeza automática: removendo "${c.titulo}" (${c.id})`);
    remover(c.id);
  }
  return antigos.length;
}

carregar();

module.exports = { listar, obter, adicionar, atualizar, remover, limparAntigos, salvar };
