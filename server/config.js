// ============================================================================
// config.js — Configuração central do FreeClip (.env + valores padrão)
// ============================================================================
const path = require('path');

const ROOT = path.join(__dirname, '..');

// Carrega o arquivo .env se existir (Node 20.12+ tem suporte nativo)
try { process.loadEnvFile(path.join(ROOT, '.env')); } catch { /* .env é opcional */ }

/** Converte variável de ambiente para inteiro com valor padrão */
function intEnv(name, padrao) {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) && v > 0 ? v : padrao;
}

module.exports = {
  ROOT,
  BIN_DIR: path.join(ROOT, 'bin'),
  DATA_DIR: path.join(ROOT, 'data'),
  CLIPS_DIR: path.join(ROOT, 'data', 'clips'),
  JOBS_DIR: path.join(ROOT, 'data', 'jobs'),
  DB_FILE: path.join(ROOT, 'data', 'clips.json'),
  PUBLIC_DIR: path.join(ROOT, 'public'),

  PORT: intEnv('PORT', 3000),
  // Limite de upload em MB (padrão 2 GB)
  MAX_UPLOAD_MB: intEnv('MAX_UPLOAD_MB', 2048),
  // Duração máxima do corte em minutos (padrão 3 min)
  MAX_CLIP_MINUTES: intEnv('MAX_CLIP_MINUTES', 3),
  // Renders simultâneos (padrão 2)
  MAX_RENDER_JOBS: intEnv('MAX_RENDER_JOBS', 2),
  // Apagar clipes/artefatos com mais de N dias (padrão 7)
  CLEANUP_DAYS: intEnv('CLEANUP_DAYS', 7),
  // Rate limit: resoluções de link da Kick por minuto, por IP
  RESOLVE_RATE_LIMIT: intEnv('RESOLVE_RATE_LIMIT', 10),
};
