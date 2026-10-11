// ============================================================================
// routes/render.js — Renderização: fila de jobs, UM único comando ffmpeg,
// progresso real via SSE, detecção de encoder por hardware e cancelamento.
// ============================================================================
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const express = require('express');
const cfg = require('../config');
const store = require('../store');
const { executar } = require('../binman');

const router = express.Router();

// Tabela de presets (espelho de public/js/layouts.js, espaço 1080×1920)
const PRESETS = {
  'cheio': [{ x: 0, y: 0, w: 1080, h: 1920 }],
  '50-50': [{ x: 0, y: 0, w: 1080, h: 960 }, { x: 0, y: 960, w: 1080, h: 960 }],
  '60-40': [{ x: 0, y: 0, w: 1080, h: 1152 }, { x: 0, y: 1152, w: 1080, h: 768 }],
  '40-60': [{ x: 0, y: 0, w: 1080, h: 768 }, { x: 0, y: 768, w: 1080, h: 1152 }],
  'pip': [{ x: 0, y: 0, w: 1080, h: 1920 }, { x: 600, y: 1280, w: 420, h: 560, pip: true }],
};
function slotsDoPreset(layout, divisao = 0.6) {
  if (PRESETS[layout]) return PRESETS[layout];
  const d = Math.min(0.8, Math.max(0.2, Number(divisao) || 0.6));
  const hA = Math.round((1920 * d) / 2) * 2;
  return [{ x: 0, y: 0, w: 1080, h: hA }, { x: 0, y: hA, w: 1080, h: 1920 - hA }];
}

// Qualidades de saída (sempre 9:16)
const QUALIDADES = { 720: [720, 1280], 1080: [1080, 1920], 1440: [1440, 2560] };

// ----------------------------------------------------------------------------
// Fila de jobs (1..N simultâneos, configurável via .env)
// ----------------------------------------------------------------------------
const jobs = new Map();   // id -> job
const fila = [];          // ids aguardando
let ativos = 0;

function novoJobId() { return crypto.randomBytes(8).toString('hex'); }

/** Arredonda para inteiro PAR (exigência do libx264) */
const par = (v) => Math.max(2, Math.round(Number(v) / 2) * 2);

function num(v, min, max, padrao) {
  v = Number(v);
  return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : padrao;
}

// ----------------------------------------------------------------------------
// Validação do corpo do POST /api/render
// ----------------------------------------------------------------------------
function validarCorpo(body, clip) {
  const b = body || {};
  const duracaoFonte = clip.duracao || 0;

  const start = num(b.start, 0, Math.max(0, duracaoFonte), 0);
  let end = num(b.end, 0.1, duracaoFonte + 1, duracaoFonte);
  if (!(end > start)) throw new Error('Trecho inválido: o fim precisa ser depois do início.');
  end = Math.min(end, duracaoFonte || end);
  const duracao = end - start;
  if (!(duracao > 0)) throw new Error('Selecione um trecho na timeline.');

  const regions = Array.isArray(b.regions) ? b.regions : [];
  if (!regions.length || regions.length > 3) throw new Error('Envie de 1 a 3 regiões.');
  for (const r of regions) {
    for (const k of ['x', 'y', 'w', 'h']) {
      if (!Number.isFinite(r[k]) || r[k] < 0 || r[k] > 1) throw new Error('Região com coordenadas inválidas.');
    }
    if (r.w < 0.005 || r.h < 0.005) throw new Error('Região pequena demais.');
    if (!Number.isInteger(r.slot) || r.slot < 0) throw new Error('Região sem slot válido.');
  }

  let slots = Array.isArray(b.slots) && b.slots.length ? b.slots : slotsDoPreset(b.layout, b.divisao);
  if (slots.length > 3) throw new Error('Máximo de 3 slots.');
  slots = slots.map((s) => ({
    x: par(Math.min(1080, Math.max(0, s.x || 0))),
    y: par(Math.min(1920, Math.max(0, s.y || 0))),
    w: par(Math.min(1080, Math.max(16, s.w || 0))),
    h: par(Math.min(1920, Math.max(16, s.h || 0))),
    pip: !!s.pip,
  }));
  for (const r of regions) {
    if (r.slot >= slots.length) throw new Error('Região aponta para um slot que não existe.');
  }

  const fps = [24, 25, 30, 50, 60].includes(Number(b.fps)) ? Number(b.fps) : 30;
  const quality = QUALIDADES[b.quality] ? Number(b.quality) : 1080;

  const bg = b.background || {};
  const modo = ['preto', 'cor', 'desfocado'].includes(bg.modo) ? bg.modo : 'preto';
  const cor = /^#[0-9a-fA-F]{6}$/.test(bg.cor || '') ? bg.cor : '#121218';

  // Headline flutuante opcional: texto em linha única + Y (0 = topo).
  // Os slots vão inteiros — o texto é desenhado sobre o vídeo, sem faixa.
  let headline = null;
  if (b.headline && typeof b.headline.texto === 'string' && b.headline.texto.trim()) {
    const fonte = path.join(cfg.PUBLIC_DIR, 'fonts', 'Anton-Regular.ttf');
    if (!fs.existsSync(fonte)) {
      throw new Error('Fonte da headline não encontrada. Reinstale o FreeClip.');
    }
    headline = {
      texto: b.headline.texto.trim().replace(/[\r\n]+/g, ' ').slice(0, 60),
      tamanho: Math.min(160, Math.max(30, Math.round(Number(b.headline.tamanho) || 84))),
      fonte,
      y: Math.round(num(b.headline.y, 0, 1920, 960)),
    };
  }

  return {
    start, end, duracao,
    regions, slots,
    layout: typeof b.layout === 'string' ? b.layout : 'custom',
    fps, quality,
    title: String(b.title || clip.titulo || 'freeclip').slice(0, 140),
    background: { modo, cor },
    ajuste: b.ajuste === 'conter' ? 'conter' : 'preencher',
    audio: b.audio !== false,
    volume: num(b.volume, 0, 100, 100),
    headline,
  };
}

// ----------------------------------------------------------------------------
// Montagem do filtro (UM único comando, sem arquivos intermediários)
// ----------------------------------------------------------------------------
function montarFiltro(p, vw, vh) {
  const cadeias = [];
  const nomes = [];

  p.regions.forEach((r, i) => {
    const s = p.slots[r.slot];
    // Recorte no vídeo de origem (inteiros pares, presos aos limites)
    let sw = par(r.w * vw), sh = par(r.h * vh);
    let sx = par(r.x * vw), sy = par(r.y * vh);
    sx = Math.min(vw - sw, Math.max(0, sx));
    sy = Math.min(vh - sh, Math.max(0, sy));
    const rot = `r${i}`;
    if (p.ajuste === 'conter') {
      // Cabe inteiro no slot; o fundo aparece nas sobras (igual ao preview)
      cadeias.push(
        `[0:v]crop=${sw}:${sh}:${sx}:${sy},format=yuva420p,` +
        `scale=${s.w}:${s.h}:force_original_aspect_ratio=decrease:flags=fast_bilinear,` +
        `pad=${s.w}:${s.h}:(ow-iw)/2:(oh-ih)/2:color=black@0[${rot}]`
      );
    } else {
      cadeias.push(
        `[0:v]crop=${sw}:${sh}:${sx}:${sy},scale=${s.w}:${s.h}:flags=fast_bilinear[${rot}]`
      );
    }
    nomes.push(rot);
  });

  // Base: preto / cor sólida / vídeo desfocado.
  // IMPORTANTE: o fundo sólido é derivado do PRÓPRIO input ([0:v]) com
  // trim(1 frame) + drawbox(t=fill) + loop FINITO. Tudo aqui é pull-based
  // (limitado pelo ritmo do consumo), então a memória fica estável.
  // (Um filtro "color" ou input lavfi gera frames sem limite e estoura a
  // RAM em máquinas modestas: "1000 buffers queued" → OOM.)
  if (p.background.modo === 'desfocado') {
    cadeias.push(
      `[0:v]scale=1080:1920:force_original_aspect_ratio=increase:flags=fast_bilinear,` +
      `crop=1080:1920,boxblur=15:3[bg]`
    );
  } else {
    const hex = (p.background.modo === 'cor' ? p.background.cor : '#000000').replace('#', '0x');
    const voltas = Math.ceil(p.duracao * p.fps) + 5;
    cadeias.push(
      `[0:v]trim=end_frame=1,setpts=PTS-STARTPTS,scale=1080:1920:flags=neighbor,` +
      `drawbox=x=0:y=0:w=1080:h=1920:color=${hex}:t=fill,` +
      `loop=loop=${voltas}:size=1,setpts=N/${p.fps}/TB[bg]`
    );
  }

  // Empilha os slots por cima da base
  let atual = 'bg';
  p.regions.forEach((r, i) => {
    const s = p.slots[r.slot];
    const prox = `o${i}`;
    cadeias.push(`[${atual}][${nomes[i]}]overlay=${s.x}:${s.y}[${prox}]`);
    atual = prox;
    if (s.pip) {
      // Moldura clara no PiP (o preview em canvas desenha a mesma borda)
      const borda = `${prox}b`;
      cadeias.push(
        `[${atual}]drawbox=x=${s.x}:y=${s.y}:w=${s.w}:h=${s.h}:t=6:color=white[${borda}]`
      );
      atual = borda;
    }
  });

  // Escala final para a qualidade + SAR 1:1.
  // O setsar=1 é ESSENCIAL: sem ele, o scale preserva o DAR da fonte (16:9)
  // e o MP4 sai 1080×1920 com etiqueta 16:9 — players/TikTok esticam tudo.
  const [W, H] = QUALIDADES[p.quality];
  let atualFinal = atual;
  if (p.headline) {
    const hl = p.headline;
    const borda = Math.max(2, Math.round(hl.tamanho / 28));
    cadeias.push(
      `[${atual}]drawtext=fontfile=${relFiltro(hl.fonte)}:textfile=${relFiltro(hl.arquivo)}:` +
      `fontsize=${hl.tamanho}:fontcolor=white:` +
      `borderw=${borda}:bordercolor=black:` +
      `shadowcolor=black@0.9:shadowx=4:shadowy=4:` +
      `x=(w-text_w)/2:y=${hl.y}-text_h/2[txt]`
    );
    atualFinal = 'txt';
  }
  cadeias.push(`[${atualFinal}]fps=${p.fps},scale=${W}:${H}:flags=fast_bilinear,setsar=1,format=yuv420p[v]`);
  return cadeias.join(';');
}

/**
 * Caminho absoluto → relativo ao cwd + barras / (sem "C:").
 * Escapa os poucos especiais restantes para o parser de filtros.
 */
function relFiltro(abs) {
  return String(path.relative(process.cwd(), abs)).split(path.sep).join('/')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]');
}

/** Argumentos de qualidade por encoder (com fallback para libx264) */
function argsDoEncoder(encoder) {
  const base = ['-c:v', encoder.id, ...(encoder.args || [])];
  switch (encoder.id) {
    case 'libx264': return [...base, '-crf', '21'];
    case 'h264_nvenc': return [...base, '-cq', '23'];
    case 'h264_qsv': return [...base, '-global_quality', '23'];
    case 'h264_amf': return [...base, '-quality', 'balanced'];
    default: return base; // videotoolbox e outros: padrões do ffmpeg
  }
}

// ----------------------------------------------------------------------------
// Execução do job
// ----------------------------------------------------------------------------
async function executarJob(job) {
  const bins = job.bins;
  const clip = store.obter(job.clipId);
  if (!clip) return finalizar(job, 'erro', 'Clipe não encontrado.');

  const fonte = path.join(cfg.CLIPS_DIR, job.clipId, 'source.mp4');
  if (!fs.existsSync(fonte)) return finalizar(job, 'erro', 'Vídeo de origem não encontrado.');

  // Dimensões reais da origem (para converter as regiões normalizadas)
  let vw = 1280, vh = 720;
  try {
    const { code, stdout } = await executar(bins.ffprobe, [
      '-v', 'quiet', '-print_format', 'json', '-show_streams', fonte,
    ]);
    if (code === 0) {
      const vs = (JSON.parse(stdout).streams || []).find((s) => s.codec_type === 'video');
      if (vs?.width && vs?.height) { vw = vs.width; vh = vs.height; }
    }
  } catch { /* mantém padrão */ }

  const tmp = path.join(cfg.CLIPS_DIR, job.clipId, `saida.${job.id}.tmp.mp4`);
  const final = path.join(cfg.CLIPS_DIR, job.clipId, 'saida.mp4');

  // Headline: grava o texto em arquivo UTF-8 para o drawtext (textfile)
  if (job.params.headline) {
    const txtPath = path.join(cfg.CLIPS_DIR, job.clipId, 'headline.txt');
    fs.writeFileSync(txtPath, job.params.headline.texto, 'utf8');
    job.params.headline.arquivo = txtPath;
  }

  const filtro = montarFiltro(job.params, vw, vh);
  const p = job.params;

  const argsBase = [
    '-y', '-hide_banner',
    '-ss', String(p.start),       // seek rápido ANTES do -i
    '-t', String(p.duracao.toFixed(3)),
    '-i', fonte,
    // O filtro vai em ARQUIVO? Não: este build do ffmpeg não tem
    // -filter_complex_script; o filtro vai na linha de comando (array,
    // sem shell) com caminhos relativos — ver montarFiltro/drawtext.
    '-filter_complex', filtro,
    '-map', '[v]',
  ];
  if (p.audio && p.volume > 0) {
    argsBase.push('-map', '0:a?');
    if (p.volume < 100) argsBase.push('-af', `volume=${(p.volume / 100).toFixed(2)}`);
    argsBase.push('-c:a', 'aac', '-b:a', '160k');
  } else {
    argsBase.push('-an');
  }
  argsBase.push('-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', tmp);

  job.inicioTs = Date.now();
  job.status = 'renderizando';
  store.atualizar(job.clipId, { status: 'compilando', progresso: 0 });
  difundir(job, 'progresso', { progresso: 0, eta: 'começando…' });

  const tentar = async (codecArgs, rotulo) => new Promise((resolve) => {
    const args = [...argsBase];
    // Insere os args do codec antes do -movflags
    const pos = args.indexOf('-movflags');
    args.splice(pos, 0, ...codecArgs);

    const proc = spawn(bins.ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    job.processo = proc;
    let stderr = '';
    let resto = '';
    let ultimaAtualizacao = 0;
    const totalUs = p.duracao * 1e6;

    proc.stdout.on('data', (d) => {
      resto += d.toString();
      const linhas = resto.split('\n');
      resto = linhas.pop();
      for (const l of linhas) {
        const m = /^out_time_ms=(\d+)/.exec(l.trim());
        if (!m) continue;
        const feito = Number(m[1]);
        const pct = Math.min(99, Math.round((feito / totalUs) * 100));
        job.progresso = pct;
        // ETA simples: ritmo médio até aqui
        const decorrido = (Date.now() - job.inicioTs) / 1000;
        let eta = 'calculando…';
        if (feito > totalUs * 0.02 && decorrido > 1) {
          const restante = (decorrido * (totalUs - feito)) / feito;
          eta = restante < 1 ? 'quase lá…' : `faltam ~${Math.round(restante)} s`;
        }
        job.eta = eta;
        const agora = Date.now();
        if (agora - ultimaAtualizacao > 800) {
          ultimaAtualizacao = agora;
          store.atualizar(job.clipId, { progresso: pct });
          difundir(job, 'progresso', { progresso: pct, eta });
        }
      }
    });
    proc.stderr.on('data', (d) => { stderr += d; });
    proc.on('error', () => resolve({ code: -1, stderr: 'falha ao iniciar o ffmpeg' }));
    proc.on('close', (code) => resolve({ code, stderr }));
  });

  // Tentativa 1: encoder por hardware (se houver); Tentativa 2: libx264
  const enc = bins.encoder || { id: 'libx264', args: ['-preset', 'veryfast'] };
  let r = await tentar(argsDoEncoder(enc), enc.nome);
  if (r.code !== 0 && enc.id !== 'libx264') {
    console.log(`[render ${job.id}] ${enc.id} falhou, tentando libx264…`);
    r = await tentar(['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21'], 'libx264');
  }

  if (job.cancelado) {
    // DELETE já respondeu; só limpa o parcial (o processo já morreu aqui)
    removerSeguro(tmp);
    return;
  }

  if (r.code !== 0 || !fs.existsSync(tmp) || fs.statSync(tmp).size === 0) {
    console.log(`[render ${job.id}] ffmpeg falhou:`, (r.stderr || '').slice(-500));
    return finalizar(job, 'erro', 'O ffmpeg não conseguiu gerar o vídeo. Tente outro trecho ou qualidade.');
  }

  fs.renameSync(tmp, final);
  const titulo = p.title;
  store.atualizar(job.clipId, { titulo, saida: 'saida.mp4', status: 'pronto', progresso: 100 });
  finalizar(job, 'pronto', null, { arquivo: 'saida.mp4' });
}

function processarFila(bins) {
  while (ativos < cfg.MAX_RENDER_JOBS && fila.length) {
    const id = fila.shift();
    const job = jobs.get(id);
    if (!job || job.status !== 'na-fila') continue;
    ativos++;
    job.bins = bins;
    executarJob(job).finally(() => {
      ativos--;
      processarFila(bins);
    });
  }
}

function finalizar(job, status, erro, extra = {}) {
  job.status = status;
  job.progresso = status === 'pronto' ? 100 : job.progresso;
  job.processo = null;
  if (status === 'pronto') {
    difundir(job, 'pronto', { progresso: 100, ...extra });
  } else {
    // Se o clipe já tinha uma saída anterior, mantém "pronto"; senão, marca erro
    const clip = store.obter(job.clipId);
    if (clip && !clip.saida) {
      store.atualizar(job.clipId, { status: 'erro', erro, progresso: 0 });
    } else if (clip) {
      store.atualizar(job.clipId, { status: 'pronto', progresso: 100 });
    }
    difundir(job, 'erro', { erro });
  }
  // Limita o histórico em memória
  if (jobs.size > 50) {
    const maisAntigo = [...jobs.values()]
      .filter((j) => j.status === 'pronto' || j.status === 'erro' || j.status === 'cancelado')
      .sort((a, b) => a.criadoEm - b.criadoEm)[0];
    if (maisAntigo) jobs.delete(maisAntigo.id);
  }
}

/** Remove arquivo ignorando erros (ex.: ainda bloqueado pelo SO) */
function removerSeguro(arquivo) {
  try { fs.rmSync(arquivo, { force: true }); } catch { /* tenta de novo em 2 s */ setTimeout(() => { try { fs.rmSync(arquivo, { force: true }); } catch {} }, 2000); }
}

/** Envia evento SSE para todos os ouvintes do job */
function difundir(job, evento, dados) {
  const linha = `event: ${evento}\ndata: ${JSON.stringify(dados)}\n\n`;
  for (const res of job.ouvintes) {
    try { res.write(linha); } catch { /* cliente desconectou */ }
  }
  if (evento === 'pronto' || evento === 'erro' || evento === 'cancelado') {
    // Fecha as conexões após o evento terminal
    setTimeout(() => {
      for (const res of job.ouvintes) { try { res.end(); } catch {} }
      job.ouvintes.clear();
    }, 500);
  }
}

// ----------------------------------------------------------------------------
// Rotas
// ----------------------------------------------------------------------------

/** POST /api/render — cria um job na fila */
router.post('/', async (req, res) => {
  const bins = req.app.locals.bins;
  if (!bins.ffmpeg) {
    return res.status(503).json({ erro: 'ffmpeg não disponível. Veja o terminal do servidor.' });
  }
  const clip = store.obter(req.body?.clipId);
  if (!clip) return res.status(404).json({ erro: 'Clipe não encontrado.' });
  const fonte = path.join(cfg.CLIPS_DIR, clip.id, 'source.mp4');
  if (!fs.existsSync(fonte)) {
    return res.status(400).json({ erro: 'Este clipe ainda não terminou de baixar.' });
  }

  let params;
  try {
    params = validarCorpo(req.body, clip);
  } catch (e) {
    return res.status(400).json({ erro: e.message });
  }

  const job = {
    id: novoJobId(),
    clipId: clip.id,
    params,
    status: 'na-fila',
    progresso: 0,
    eta: 'na fila…',
    criadoEm: Date.now(),
    inicioTs: null,
    processo: null,
    cancelado: false,
    ouvintes: new Set(),
    bins: null,
  };
  jobs.set(job.id, job);
  fila.push(job.id);
  store.atualizar(clip.id, { status: 'compilando', progresso: 0 });
  processarFila(bins);

  res.json({ job: { id: job.id, status: job.status } });
});

/** GET /api/render/:id — status atual (polling simples, alternativa ao SSE) */
router.get('/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ erro: 'Job não encontrado.' });
  res.json({
    job: { id: job.id, status: job.status, progresso: job.progresso, eta: job.eta },
  });
});

/** GET /api/render/:id/events — progresso em tempo real via SSE */
router.get('/:id/events', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ erro: 'Job não encontrado.' });

  req.socket.setTimeout(0); // SSE pode durar vários minutos
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write(':\n\n'); // handshake
  job.ouvintes.add(res);

  // Estado atual imediato (inclusive terminal, para quem chegou atrasado)
  if (job.status === 'pronto') {
    res.write(`event: pronto\ndata: ${JSON.stringify({ progresso: 100, arquivo: 'saida.mp4' })}\n\n`);
  } else if (job.status === 'erro') {
    res.write(`event: erro\ndata: ${JSON.stringify({ erro: job.erro || 'Falha na compilação.' })}\n\n`);
  } else if (job.status === 'cancelado') {
    res.write(`event: erro\ndata: ${JSON.stringify({ erro: 'Compilação cancelada.' })}\n\n`);
  } else {
    res.write(`event: progresso\ndata: ${JSON.stringify({ progresso: job.progresso, eta: job.eta })}\n\n`);
  }

  // Keep-alive a cada 20 s (evita proxies derrubarem a conexão)
  const ping = setInterval(() => { try { res.write(':\n\n'); } catch {} }, 20000);
  req.on('close', () => {
    clearInterval(ping);
    job.ouvintes.delete(res);
  });
});

/** DELETE /api/render/:id — cancela o job, mata o ffmpeg e limpa o parcial */
router.delete('/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ erro: 'Job não encontrado.' });

  job.cancelado = true;
  job.status = 'cancelado';
  const pos = fila.indexOf(job.id);
  if (pos >= 0) fila.splice(pos, 1); // ainda estava na fila

  // Mata o processo (no Windows o lock do arquivo solta logo após a morte;
  // a limpeza final acontece no ramo `cancelado` do executarJob)
  if (job.processo) {
    try { job.processo.kill('SIGKILL'); } catch {}
    job.processo = null;
  }

  const clip = store.obter(job.clipId);
  if (clip) store.atualizar(job.clipId, { status: 'pronto', progresso: clip.saida ? 100 : 100 });
  for (const ouv of job.ouvintes) {
    try { ouv.write(`event: erro\ndata: ${JSON.stringify({ erro: 'Compilação cancelada.' })}\n\n`); } catch {}
  }
  setTimeout(() => {
    for (const ouv of [...job.ouvintes]) { try { ouv.end(); } catch {} }
    job.ouvintes.clear();
  }, 500);
  res.json({ ok: true });
});

module.exports = router;
