// ============================================================================
// config.js — Configuração central do FreeClip (.env + valores padrão)
// ============================================================================
const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * CPUs efetivas: em container (Docker/Render) o os.cpus() mostra os núcleos
 * do HOST, não a cota do container — então lê a cota do cgroup. Ex.: plano
 * free com "10000 100000" = 0.1 CPU. Fora do Linux, usa os.cpus().
 */
function cpusEfetivos() {
  try {
    const v2 = fs.readFileSync('/sys/fs/cgroup/cpu.max', 'utf8').trim().split(/\s+/);
    if (v2[0] !== 'max') {
      const q = Number(v2[0]) / (Number(v2[1]) || 100000);
      if (Number.isFinite(q) && q > 0) return q;
    }
  } catch { /* sem cgroup v2 */ }
  try {
    const quota = Number(fs.readFileSync('/sys/fs/cgroup/cpu/cpu.cfs_quota_us', 'utf8'));
    const period = Number(fs.readFileSync('/sys/fs/cgroup/cpu/cpu.cfs_period_us', 'utf8')) || 100000;
    if (quota > 0) return quota / period;
  } catch { /* sem cgroup v1 */ }
  return os.cpus().length;
}

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
  // Renders simultâneos: 1 em máquinas fracas (≤2 CPUs efetivas, ex.: plano
  // free), 2 nas demais. Em host fraco, 2 jobs paralelos disputam a mesma
  // CPU minúscula e AMBOS ficam mais lentos — por isso o padrão é adaptativo
  // (configure MAX_RENDER_JOBS no .env para forçar um valor).
  MAX_RENDER_JOBS: process.env.MAX_RENDER_JOBS
    ? intEnv('MAX_RENDER_JOBS', 2)
    : (cpusEfetivos() <= 2 ? 1 : 2),
  // Apagar clipes/artefatos com mais de N dias (padrão 7)
  CLEANUP_DAYS: intEnv('CLEANUP_DAYS', 7),
  // Rate limit: resoluções de link da Kick por minuto, por IP
  RESOLVE_RATE_LIMIT: intEnv('RESOLVE_RATE_LIMIT', 10),
};
