// ============================================================================
// binman.js — Gerenciador de binários externos (ffmpeg, ffprobe, yt-dlp)
// ----------------------------------------------------------------------------
// No primeiro start, verifica se os binários existem (em ./bin ou no PATH).
// Se não existirem, baixa automaticamente para ./bin (Windows/Linux/Mac).
// Também detecta o melhor encoder de vídeo por hardware (NVENC, QSV, AMF,
// VideoToolbox) com fallback para libx264.
// ============================================================================
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');
const AdmZip = require('adm-zip');
const { BIN_DIR } = require('./config');

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

/** Nome do executável conforme a plataforma */
function binName(base) {
  return IS_WIN ? `${base}.exe` : base;
}

/** Caminho completo do binário dentro de ./bin */
function binPath(base) {
  return path.join(BIN_DIR, binName(base));
}

// URLs oficiais de download (sempre gratuitas)
const URLS = {
  ffmpeg: {
    win32: 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip',
    // Builds estáticos para macOS (evermeet) — ffmpeg e ffprobe separados
    darwin: 'https://evermeet.cx/ffmpeg/getrelease/zip',
  },
  ffprobe: {
    darwin: 'https://evermeet.cx/ffmpeg/getrelease/ffprobe/zip',
  },
  ytdlp: {
    win32: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe',
    darwin: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos',
    linux: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp',
  },
};

// ----------------------------------------------------------------------------
// Utilidades
// ----------------------------------------------------------------------------

/** Verifica se um comando funciona executando `-version` */
function funciona(cmd, args = ['-version']) {
  try {
    const r = spawnSync(cmd, args, { timeout: 20000, stdio: 'pipe' });
    return r.status === 0 ? (r.stdout?.toString().split('\n')[0] || 'ok') : false;
  } catch {
    return false;
  }
}

/** Baixa uma URL para um arquivo com barra de progresso no console */
async function baixarArquivo(url, destino, rotulo = 'arquivo') {
  console.log(`⬇  Baixando ${rotulo}...`);
  console.log(`   ${url}`);
  const resp = await fetch(url, { redirect: 'follow' });
  if (!resp.ok) throw new Error(`Falha no download (HTTP ${resp.status})`);

  const total = Number(resp.headers.get('content-length') || 0);
  const tmp = destino + '.part';
  const out = fs.createWriteStream(tmp);

  // resp.body é um Web Stream (undici): converte para Node stream
  const corpo = Readable.fromWeb(resp.body);

  // Mostra progresso em MB (simples, sem poluir o terminal)
  let baixado = 0;
  let ultimoLog = 0;
  corpo.on('data', (chunk) => {
    baixado += chunk.length;
    if (baixado - ultimoLog > 10 * 1024 * 1024) {
      ultimoLog = baixado;
      const mb = (baixado / 1048576).toFixed(1);
      const pct = total ? ` (${Math.round((baixado / total) * 100)}%)` : '';
      console.log(`   ...${mb} MB${pct}`);
    }
  });

  await pipeline(corpo, out);
  fs.renameSync(tmp, destino);
  console.log(`✔  ${rotulo} baixado (${(fs.statSync(destino).size / 1048576).toFixed(1)} MB)`);
}

/** Garante permissão de execução em sistemas Unix */
function tornarExecutavel(p) {
  if (!IS_WIN) {
    try { fs.chmodSync(p, 0o755); } catch { /* ignore */ }
  }
}

// ----------------------------------------------------------------------------
// ffmpeg + ffprobe
// ----------------------------------------------------------------------------

/** Tenta localizar ffmpeg/ffprobe: primeiro ./bin, depois o PATH do sistema */
function localizarBinario(base) {
  const local = binPath(base);
  if (fs.existsSync(local)) {
    const v = funciona(local);
    if (v) return { caminho: local, versao: v };
  }
  const v = funciona(binName(base)) || funciona(base);
  if (v) return { caminho: binName(base), versao: v, sistema: true };
  return null;
}

/** Baixa e instala ffmpeg + ffprobe conforme a plataforma */
async function instalarFfmpeg() {
  fs.mkdirSync(BIN_DIR, { recursive: true });

  if (IS_WIN) {
    // Build "essentials" da gyan.dev: zip com bin/ffmpeg.exe e bin/ffprobe.exe
    const zipPath = path.join(BIN_DIR, 'ffmpeg.zip');
    await baixarArquivo(URLS.ffmpeg.win32, zipPath, 'ffmpeg (Windows)');
    const zip = new AdmZip(zipPath);
    // Procura os executáveis dentro do zip (a pasta interna muda a cada versão)
    for (const base of ['ffmpeg.exe', 'ffprobe.exe']) {
      const entry = zip.getEntries().find((e) => e.entryName.endsWith(`bin/${base}`));
      if (!entry) throw new Error(`${base} não encontrado no pacote do ffmpeg`);
      fs.writeFileSync(binPath(base.replace('.exe', '')), entry.getData());
    }
    fs.unlinkSync(zipPath); // limpa o zip
  } else if (IS_MAC) {
    for (const [base, url] of [['ffmpeg', URLS.ffmpeg.darwin], ['ffprobe', URLS.ffprobe.darwin]]) {
      const zipPath = path.join(BIN_DIR, `${base}.zip`);
      await baixarArquivo(url, zipPath, `${base} (macOS)`);
      const zip = new AdmZip(zipPath);
      zip.extractAllTo(BIN_DIR, true);
      fs.unlinkSync(zipPath);
      tornarExecutavel(binPath(base));
    }
  } else {
    // Linux: não há zip estável de link único; orienta o usuário
    return false;
  }
  return true;
}

/** Instruções amigáveis quando o download automático não é possível */
function instrucoesFfmpeg() {
  if (IS_WIN) {
    return [
      'Não foi possível baixar o ffmpeg automaticamente.',
      'Baixe em: https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip',
      'Extraia e coloque ffmpeg.exe e ffprobe.exe na pasta ./bin do FreeClip.',
    ].join('\n');
  }
  if (IS_MAC) return 'Instale com: brew install ffmpeg    (ou coloque ffmpeg/ffprobe em ./bin)';
  return 'Instale com seu gerenciador de pacotes, ex.: sudo apt install ffmpeg\n(ou coloque os binários ffmpeg e ffprobe em ./bin)';
}

// ----------------------------------------------------------------------------
// yt-dlp
// ----------------------------------------------------------------------------

/** Baixa (ou atualiza) o yt-dlp para ./bin */
async function baixarYtDlp() {
  fs.mkdirSync(BIN_DIR, { recursive: true });
  const url = URLS.ytdlp[process.platform] || URLS.ytdlp.linux;
  await baixarArquivo(url, binPath('yt-dlp'), 'yt-dlp');
  tornarExecutavel(binPath('yt-dlp'));
  return binPath('yt-dlp');
}

// ----------------------------------------------------------------------------
// Detecção de encoder por hardware
// ----------------------------------------------------------------------------

/**
 * Testa encoders de hardware na prática: codifica 0,1s de vídeo de teste.
 * Retorna o primeiro que funcionar; se nenhum, usa libx264 (CPU).
 */
function detectarEncoder(ffmpegPath) {
  const candidatos = [
    // NVIDIA (Windows/Linux)
    { id: 'h264_nvenc', nome: 'NVIDIA NVENC', args: ['-preset', 'p4'] },
    // Intel Quick Sync (Windows/Linux)
    { id: 'h264_qsv', nome: 'Intel Quick Sync', args: [] },
    // AMD AMF (Windows/Linux)
    { id: 'h264_amf', nome: 'AMD AMF', args: [] },
    // Apple (macOS)
    { id: 'h264_videotoolbox', nome: 'Apple VideoToolbox', args: [] },
  ];

  for (const enc of candidatos) {
    if (IS_WIN === false && enc.id === 'h264_amf' && process.platform !== 'linux') continue;
    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc2=duration=0.1:size=128x72:rate=30',
      '-c:v', enc.id, ...enc.args,
      '-f', 'null', '-',
    ];
    try {
      const r = spawnSync(ffmpegPath, args, { timeout: 30000, stdio: 'pipe' });
      if (r.status === 0) {
        return { id: enc.id, nome: enc.nome, args: enc.args, hardware: true };
      }
    } catch { /* tenta o próximo */ }
  }
  return { id: 'libx264', nome: 'libx264 (CPU)', args: ['-preset', 'veryfast'], hardware: false };
}

// ----------------------------------------------------------------------------
// Inicialização
// ----------------------------------------------------------------------------

/**
 * Garante que todos os binários existam. Retorna um objeto `bins` com os
 * caminhos e informações, usado pelo resto do servidor.
 */
async function garantirBinarios() {
  const bins = { ok: true, faltando: [] };

  console.log('\n═══ FreeClip — verificando dependências ═══');

  // --- yt-dlp ---
  let ytdlp = localizarBinario('yt-dlp');
  if (!ytdlp || ytdlp.sistema) {
    try {
      const p = await baixarYtDlp();
      ytdlp = { caminho: p, versao: funciona(p) || '?' };
    } catch (e) {
      console.error(`✖  yt-dlp: ${e.message}`);
    }
  } else {
    console.log(`✔  yt-dlp encontrado (${ytdlp.versao})`);
  }
  if (ytdlp?.caminho) bins.ytdlp = ytdlp.caminho;
  else bins.faltando.push('yt-dlp');

  // --- ffmpeg / ffprobe ---
  let ffmpeg = localizarBinario('ffmpeg');
  let ffprobe = localizarBinario('ffprobe');
  if (!ffmpeg || !ffprobe) {
    try {
      if (await instalarFfmpeg()) {
        ffmpeg = localizarBinario('ffmpeg');
        ffprobe = localizarBinario('ffprobe');
      }
    } catch (e) {
      console.error(`✖  ffmpeg: ${e.message}`);
      console.error(`\n${instrucoesFfmpeg()}\n`);
    }
  } else {
    console.log(`✔  ffmpeg encontrado (${ffmpeg.versao})`);
  }
  if (ffmpeg?.caminho && ffprobe?.caminho) {
    bins.ffmpeg = ffmpeg.caminho;
    bins.ffprobe = ffprobe.caminho;
    bins.ffmpegVersao = ffmpeg.versao;
  } else {
    bins.faltando.push('ffmpeg');
    // Não aborta: o servidor sobe mesmo assim e o /api/health mostra o que falta
    console.error(`\n${instrucoesFfmpeg()}\n`);
  }

  bins.ok = bins.faltando.length === 0;

  // --- Encoder por hardware (só se tiver ffmpeg) ---
  if (bins.ffmpeg) {
    console.log('⚙  Detectando encoder de hardware...');
    bins.encoder = detectarEncoder(bins.ffmpeg);
    console.log(`✔  Encoder ativo: ${bins.encoder.nome}`);
  } else {
    bins.encoder = { id: 'libx264', nome: 'indisponível (sem ffmpeg)', args: [], hardware: false };
  }

  console.log('═══════════════════════════════════════════\n');
  return bins;
}

/** Executa um binário e resolve com {code, stdout, stderr} */
function executar(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => { stdout += d; });
    p.stderr.on('data', (d) => { stderr += d; });
    p.on('error', (e) => resolve({ code: -1, stdout, stderr: String(e) }));
    p.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

module.exports = {
  garantirBinarios,
  baixarYtDlp,
  detectarEncoder,
  executar,
  funciona,
  binPath,
};
