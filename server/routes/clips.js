// ============================================================================
// routes/clips.js — Endpoints de clipes: resolve (Kick), upload, biblioteca,
// servir mídia com suporte a Range, thumbnails e sprite da timeline.
// ============================================================================
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { Readable } = require('stream');
const express = require('express');
const multer = require('multer');
const cfg = require('../config');
const store = require('../store');
const { executar, funciona } = require('../binman');
const { validarUrlKick, metadadosViaYtDlp, infoViaApiKick, ERRO_DOWNLOAD } = require('../kick');

const router = express.Router();

// ----------------------------------------------------------------------------
// Rate limit simples por IP para resolução de links (janela deslizante de 1 min)
// ----------------------------------------------------------------------------
const historicoResolve = new Map(); // ip -> [timestamps]
function limiteResolve(req, res, next) {
  const ip = req.ip || 'local';
  const agora = Date.now();
  const lista = (historicoResolve.get(ip) || []).filter((t) => agora - t < 60000);
  if (lista.length >= cfg.RESOLVE_RATE_LIMIT) {
    return res.status(429).json({
      erro: `Muitas tentativas seguidas. Aguarde um minuto e tente de novo.`,
    });
  }
  lista.push(agora);
  historicoResolve.set(ip, lista);
  next();
}

// ----------------------------------------------------------------------------
// Utilidades
// ----------------------------------------------------------------------------

function novoId() {
  return crypto.randomBytes(8).toString('hex');
}

function dirDoClipe(id) {
  return path.join(cfg.CLIPS_DIR, id);
}

/** Sanitiza títulos para uso em nomes de arquivo (download) */
function nomeSeguro(titulo) {
  return (titulo || 'freeclip')
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // remove acentos
    .replace(/[^\w\s-]/g, '')
    .trim().replace(/\s+/g, ' ')
    .slice(0, 80) || 'freeclip';
}

/** Extrai metadados do vídeo local com ffprobe */
async function probe(ffprobePath, arquivo) {
  const { code, stdout } = await executar(ffprobePath, [
    '-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', arquivo,
  ]);
  if (code !== 0) throw new Error('Não consegui ler as informações deste vídeo.');
  const info = JSON.parse(stdout);
  const vs = (info.streams || []).find((s) => s.codec_type === 'video');
  if (!vs) throw new Error('Este arquivo não parece conter vídeo.');
  const [num, den] = String(vs.r_frame_rate || '30/1').split('/').map(Number);
  return {
    largura: vs.width,
    altura: vs.height,
    fps: den ? Math.round((num / den) * 100) / 100 : 30,
    duracao: Number(info.format?.duration) || Number(vs.duration) || 0,
  };
}

/** Gera thumbnail única (capa do card) */
async function gerarCapa(ffmpegPath, arquivo, destino) {
  await executar(ffmpegPath, [
    '-y', '-ss', '0.5', '-i', arquivo,
    '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '5', destino,
  ], { timeout: 30000 });
}

/**
 * Gera miniaturas da timeline: 1 frame a cada N segundos, em
 * data/clips/{id}/thumbs/thumb_0001.jpg ... Retorna a quantidade gerada.
 */
async function gerarMiniaturas(ffmpegPath, arquivo, pastaThumbs, duracao) {
  fs.mkdirSync(pastaThumbs, { recursive: true });
  // Alvo ~40 miniaturas; intervalo mínimo de 1s
  const intervalo = Math.max(1, Math.floor((duracao || 40) / 40));
  await executar(ffmpegPath, [
    '-y', '-i', arquivo,
    '-vf', `fps=1/${intervalo},scale=160:-2`,
    '-q:v', '6', path.join(pastaThumbs, 'thumb_%04d.jpg'),
  ], { timeout: 300000 });
  const qtd = fs.readdirSync(pastaThumbs).filter((f) => f.endsWith('.jpg')).length;
  return { qtd, intervalo };
}

/** Registra que o processamento de um clipe falhou com mensagem amigável */
function marcarErro(id, msg) {
  store.atualizar(id, { status: 'erro', erro: msg, progresso: 0 });
}

// ----------------------------------------------------------------------------
// Download do clipe (yt-dlp com fallback para a API da Kick)
// ----------------------------------------------------------------------------

/**
 * Baixa o vídeo do clipe para source.mp4 usando, na ordem:
 * 1) yt-dlp direto (resolve m3u8 e mp4, remuxando para mp4 com ffmpeg)
 * 2) API pública da Kick + (ffmpeg para m3u8 | fetch para mp4)
 * Ao final, garante +faststart e extrai metadados com ffprobe.
 */
async function baixarClipe(bins, clip) {
  const { id } = clip;
  const dir = dirDoClipe(id);
  fs.mkdirSync(dir, { recursive: true });
  const destino = path.join(dir, 'source.mp4');
  const setProg = (p) => store.atualizar(id, { progresso: Math.min(99, Math.round(p)) });

  // --- Tentativa 1: yt-dlp faz o download inteiro ---
  let ok = false;
  try {
    ok = await new Promise((resolve) => {
      // -f best[ext=mp4]/best: prefere mp4 direto; --merge-output-format mp4
      // remuxa HLS/webm para mp4 quando necessário.
      const args = [
        '--no-playlist', '--no-warnings', '--newline',
        '-f', 'best[ext=mp4]/best',
        '--merge-output-format', 'mp4',
        // Fragmentos paralelos: acelera muito o download de HLS (.m3u8),
        // que é o formato mais comum dos clipes da Kick
        '--concurrent-fragments', '4',
        '--ffmpeg-location', path.dirname(bins.ffmpeg),
        '-o', destino,
        clip.urlCanonica,
      ];
      const p = spawn(bins.ytdlp, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      p.stderr.on('data', (d) => { stderr += d; });
      p.stdout.on('data', (d) => {
        // yt-dlp imprime "[download]  45.2% of ..." — usamos para o progresso
        const m = d.toString().match(/([\d.]+)%/);
        if (m) setProg(parseFloat(m[1]));
      });
      p.on('error', () => resolve(false));
      p.on('close', (code) => {
        if (code !== 0) console.log(`[yt-dlp] falhou (${clip.id}):`, stderr.slice(-300));
        resolve(code === 0 && fs.existsSync(destino) && fs.statSync(destino).size > 0);
      });
    });
  } catch { ok = false; }

  // --- Tentativa 2: API da Kick -> ffmpeg (m3u8) ou fetch (mp4) ---
  if (!ok) {
    try {
      const info = await infoViaApiKick(clip.clipId);
      if (!clip.titulo) store.atualizar(id, { titulo: info.titulo });
      setProg(10);
      if (info.videoUrl.endsWith('.m3u8') || info.videoUrl.includes('playlist')) {
        // HLS: ffmpeg baixa e remuxa para mp4 sem re-encodar
        const { code } = await executar(bins.ffmpeg, [
          '-y', '-user_agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
          '-i', info.videoUrl, '-c', 'copy', '-bsf:a', 'aac_adtstoasc', destino,
        ], { timeout: 600000 });
        ok = code === 0 && fs.existsSync(destino);
      } else {
        // MP4 direto via stream
        const resp = await fetch(info.videoUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Referer': 'https://kick.com/' },
          signal: AbortSignal.timeout(600000),
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const total = Number(resp.headers.get('content-length') || 0);
        const corpo = Readable.fromWeb(resp.body);
        let baixado = 0;
        corpo.on('data', (c) => { baixado += c.length; if (total) setProg((baixado / total) * 95); });
        await require('stream/promises').pipeline(corpo, fs.createWriteStream(destino));
        ok = fs.statSync(destino).size > 0;
      }
    } catch (e) {
      console.log(`[api-kick] falhou (${clip.id}):`, e.message);
      ok = false;
    }
  }

  if (!ok) return marcarErro(id, ERRO_DOWNLOAD);
  await finalizarClipe(bins, id, destino);
}

/** Pós-download: faststart + metadados + capa + miniaturas da timeline */
async function finalizarClipe(bins, id, sourcePath) {
  try {
    // Remux com +faststart: preview e render leem arquivo local com seek instantâneo
    setProgStore(id, 97);
    const tmp = sourcePath.replace('.mp4', '.fast.mp4');
    const r = await executar(bins.ffmpeg, [
      '-y', '-i', sourcePath, '-c', 'copy', '-movflags', '+faststart', tmp,
    ], { timeout: 300000 });
    if (r.code === 0 && fs.existsSync(tmp) && fs.statSync(tmp).size > 0) {
      fs.renameSync(tmp, sourcePath);
    }

    const meta = await probe(bins.ffprobe, sourcePath);
    await gerarCapa(bins.ffmpeg, sourcePath, path.join(dirDoClipe(id), 'thumb.jpg'));

    store.atualizar(id, {
      status: 'pronto',
      progresso: 100,
      duracao: meta.duracao,
      largura: meta.largura,
      altura: meta.altura,
      fps: meta.fps,
      tamanho: fs.statSync(sourcePath).size,
    });

    // Miniaturas da timeline em segundo plano (não bloqueia o "pronto")
    gerarMiniaturas(bins.ffmpeg, sourcePath, path.join(dirDoClipe(id), 'thumbs'), meta.duracao)
      .then(({ qtd, intervalo }) => store.atualizar(id, { miniaturas: qtd, intervaloMiniaturas: intervalo }))
      .catch(() => { /* opcional */ });
  } catch (e) {
    marcarErro(id, e.message);
  }

  function setProgStore(cid, p) {
    store.atualizar(cid, { progresso: p });
  }
}

// ----------------------------------------------------------------------------
// Rotas
// ----------------------------------------------------------------------------

/** POST /api/clips/resolve — valida, cria o registro e baixa em background */
router.post('/resolve', limiteResolve, async (req, res) => {
  const bins = req.app.locals.bins;
  if (!bins.ytdlp || !bins.ffmpeg) {
    return res.status(503).json({
      erro: 'O yt-dlp e/ou ffmpeg não estão disponíveis. Veja as instruções no terminal do servidor.',
    });
  }
  let dados;
  try {
    dados = validarUrlKick(req.body?.url || '');
  } catch (e) {
    return res.status(400).json({ erro: e.message });
  }

  const id = novoId();
  const clip = store.adicionar({
    id,
    titulo: 'Obtendo clipe…',
    url: req.body.url.trim(),
    urlCanonica: dados.urlCanonica,
    clipId: dados.clipId,
    origem: 'kick',
    status: 'baixando',
    progresso: 0,
    criadoEm: Date.now(),
    saida: null, // nome do MP4 final, quando compilado
  });
  res.json({ clip });

  // Metadados rápidos (título), sem bloquear a resposta
  metadadosViaYtDlp(bins.ytdlp, dados.urlCanonica)
    .then((m) => { if (m?.titulo) store.atualizar(id, { titulo: m.titulo }); })
    .catch(() => {});

  baixarClipe(bins, store.obter(id));
});

/** POST /api/clips/upload — upload manual de vídeo (arrastar e soltar) */
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const id = novoId();
      req.clipId = id;
      const dir = dirDoClipe(id);
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => cb(null, 'source.original'),
  }),
  limits: { fileSize: cfg.MAX_UPLOAD_MB * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /\.(mp4|mov|webm|mkv)$/i.test(file.originalname || '');
    cb(ok ? null : new Error('Formato não suportado. Envie MP4, MOV, WEBM ou MKV.'), ok);
  },
});

router.post('/upload', (req, res) => {
  const bins = req.app.locals.bins;
  if (!bins.ffmpeg) {
    return res.status(503).json({ erro: 'ffmpeg não disponível. Veja o terminal do servidor.' });
  }
  upload.single('arquivo')(req, res, async (err) => {
    if (err) {
      return res.status(400).json({
        erro: err.code === 'LIMIT_FILE_SIZE'
          ? `Arquivo muito grande. Limite: ${cfg.MAX_UPLOAD_MB} MB.`
          : (err.message || 'Falha no upload.'),
      });
    }
    if (!req.file) return res.status(400).json({ erro: 'Nenhum arquivo enviado.' });

    const id = req.clipId;
    const dir = dirDoClipe(id);
    const sourcePath = path.join(dir, 'source.mp4');

    const clip = store.adicionar({
      id,
      titulo: (path.basename(req.file.originalname, path.extname(req.file.originalname)) || 'Vídeo enviado').slice(0, 140),
      url: null,
      origem: 'upload',
      status: 'processando',
      progresso: 50,
      criadoEm: Date.now(),
      saida: null,
    });
    res.json({ clip });

    // Converte qualquer formato para MP4 faststart (re-encode leve só se preciso)
    try {
      const { code } = await executar(bins.ffmpeg, [
        '-y', '-i', req.file.path,
        '-c:v', 'copy', '-c:a', 'aac', '-movflags', '+faststart', sourcePath,
      ], { timeout: 600000 });
      if (code !== 0) {
        // Fallback: re-encoda (ex.: webm vp9 -> h264)
        const r2 = await executar(bins.ffmpeg, [
          '-y', '-i', req.file.path,
          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
          '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', sourcePath,
        ], { timeout: 1200000 });
        if (r2.code !== 0) throw new Error('Não consegui converter este vídeo. Tente outro arquivo.');
      }
      fs.rmSync(req.file.path, { force: true });
      await finalizarClipe(bins, id, sourcePath);
    } catch (e) {
      fs.rmSync(req.file.path, { force: true });
      marcarErro(id, e.message);
    }
  });
});

/** GET /api/clips — biblioteca */
router.get('/', (req, res) => res.json({ clips: store.listar() }));

/** GET /api/clips/:id — status individual (polling leve do frontend) */
router.get('/:id', (req, res) => {
  const clip = store.obter(req.params.id);
  if (!clip) return res.status(404).json({ erro: 'Clipe não encontrado.' });
  res.json({ clip });
});

/** PATCH /api/clips/:id — renomear (e salvar edições futuras) */
router.patch('/:id', (req, res) => {
  const clip = store.obter(req.params.id);
  if (!clip) return res.status(404).json({ erro: 'Clipe não encontrado.' });
  const patch = {};
  if (typeof req.body?.titulo === 'string' && req.body.titulo.trim()) {
    patch.titulo = req.body.titulo.trim().slice(0, 140);
  }
  if (req.body?.editor && typeof req.body.editor === 'object') {
    patch.editor = req.body.editor; // layout/regiões/corte salvos pelo editor
  }
  store.atualizar(clip.id, patch);
  res.json({ clip: store.obter(clip.id) });
});

/** DELETE /api/clips/:id — excluir clipe e seus arquivos */
router.delete('/:id', (req, res) => {
  if (!store.remover(req.params.id)) return res.status(404).json({ erro: 'Clipe não encontrado.' });
  res.json({ ok: true });
});

/** GET /api/clips/:id/download — baixa o MP4 final com o título como nome */
router.get('/:id/download', (req, res) => {
  const clip = store.obter(req.params.id);
  if (!clip?.saida) return res.status(404).json({ erro: 'Este clipe ainda não foi compilado.' });
  const arquivo = path.join(dirDoClipe(clip.id), clip.saida);
  if (!fs.existsSync(arquivo)) return res.status(404).json({ erro: 'Arquivo final não encontrado.' });
  res.download(arquivo, `${nomeSeguro(clip.titulo)}.mp4`);
});

/** POST /api/clips/limpar-cache — botão "Limpar cache" da interface */
router.post('/limpar-cache', (req, res) => {
  const removidos = store.limparAntigos(req.app.locals.cfg.CLEANUP_DAYS);
  res.json({ ok: true, removidos });
});

// ----------------------------------------------------------------------------
// Servir mídia com suporte a RANGE REQUESTS (essencial para seek no player)
// ----------------------------------------------------------------------------
function servirComRange(req, res, arquivo, mime) {
  const stat = fs.statSync(arquivo);
  const total = stat.size;
  const range = req.headers.range;

  if (!range) {
    res.writeHead(200, {
      'Content-Length': total,
      'Content-Type': mime,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-cache',
    });
    return fs.createReadStream(arquivo).pipe(res);
  }

  // Ex.: "bytes=1024-2047" ou "bytes=1024-"
  const m = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!m) return res.status(416).end();
  const inicio = m[1] ? parseInt(m[1], 10) : 0;
  const fim = m[2] ? Math.min(parseInt(m[2], 10), total - 1) : total - 1;
  if (inicio > fim || inicio >= total) {
    res.writeHead(416, { 'Content-Range': `bytes */${total}` });
    return res.end();
  }
  res.writeHead(206, {
    'Content-Range': `bytes ${inicio}-${fim}/${total}`,
    'Accept-Ranges': 'bytes',
    'Content-Length': fim - inicio + 1,
    'Content-Type': mime,
    'Cache-Control': 'no-cache',
  });
  fs.createReadStream(arquivo, { start: inicio, end: fim }).pipe(res);
}

const mediaRouter = express.Router();

mediaRouter.get('/:id/source.mp4', (req, res) => {
  const clip = store.obter(req.params.id);
  const arquivo = clip && path.join(dirDoClipe(clip.id), 'source.mp4');
  if (!arquivo || !fs.existsSync(arquivo)) return res.status(404).json({ erro: 'Vídeo não encontrado.' });
  servirComRange(req, res, arquivo, 'video/mp4');
});

mediaRouter.get('/:id/saida.mp4', (req, res) => {
  const clip = store.obter(req.params.id);
  if (!clip?.saida) return res.status(404).json({ erro: 'Este clipe ainda não foi compilado.' });
  const arquivo = path.join(dirDoClipe(clip.id), clip.saida);
  if (!fs.existsSync(arquivo)) return res.status(404).json({ erro: 'Arquivo final não encontrado.' });
  servirComRange(req, res, arquivo, 'video/mp4');
});

mediaRouter.get('/:id/thumb.jpg', (req, res) => {
  const arquivo = path.join(dirDoClipe(req.params.id), 'thumb.jpg');
  if (!fs.existsSync(arquivo)) return res.status(404).end();
  res.setHeader('Cache-Control', 'public, max-age=60');
  fs.createReadStream(arquivo).pipe(res);
});

// Miniaturas da timeline: /media/:id/thumbs/12.jpg
mediaRouter.get('/:id/thumbs/:n.jpg', (req, res) => {
  const n = String(parseInt(req.params.n, 10) || 0).padStart(4, '0');
  const arquivo = path.join(dirDoClipe(req.params.id), 'thumbs', `thumb_${n}.jpg`);
  if (!fs.existsSync(arquivo)) return res.status(404).end();
  res.setHeader('Cache-Control', 'public, max-age=3600');
  fs.createReadStream(arquivo).pipe(res);
});

module.exports = { router, mediaRouter };
