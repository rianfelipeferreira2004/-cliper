// ============================================================================
// index.js — Servidor principal do FreeClip
// ============================================================================
const fs = require('fs');
const path = require('path');
const express = require('express');
const cfg = require('./config');
const { garantirBinarios } = require('./binman');

// ----------------------------------------------------------------------------
// Bootstrap: garante pastas e binários antes de aceitar requisições
// ----------------------------------------------------------------------------

/** Garante a estrutura de pastas e um .env padrão */
function prepararEstrutura() {
  for (const dir of [cfg.BIN_DIR, cfg.DATA_DIR, cfg.CLIPS_DIR, cfg.JOBS_DIR, cfg.PUBLIC_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  // Cria o .env a partir do exemplo na primeira execução
  const envPath = path.join(cfg.ROOT, '.env');
  const envExemplo = path.join(cfg.ROOT, '.env.example');
  if (!fs.existsSync(envPath) && fs.existsSync(envExemplo)) {
    fs.copyFileSync(envExemplo, envPath);
  }
}

(async function iniciar() {
  prepararEstrutura();

  // Garante ffmpeg/ffprobe/yt-dlp (baixa se necessário)
  const bins = await garantirBinarios();

  // --------------------------------------------------------------------------
  // Express
  // --------------------------------------------------------------------------
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  // Arquivos estáticos do frontend
  app.use(express.static(cfg.PUBLIC_DIR));
  // Biblioteca interact.js servida localmente (funciona offline)
  app.get('/vendor/interact.min.js', (req, res) => {
    res.sendFile(require.resolve('interactjs/dist/interact.min.js'));
  });

  // Deixa os binários e a configuração disponíveis para as rotas
  app.locals.bins = bins;
  app.locals.cfg = cfg;

  // --- Rotas da API (adicionadas por fase) ---
  const clipsRoutes = require('./routes/clips');
  app.use('/api/clips', clipsRoutes.router);
  app.use('/media', clipsRoutes.mediaRouter);
  app.use('/api/render', require('./routes/render'));

  app.get('/api/health', (req, res) => {
    res.json({
      ok: bins.ok,
      ffmpeg: !!bins.ffmpeg,
      ffprobe: !!bins.ffprobe,
      ytdlp: !!bins.ytdlp,
      encoder: bins.encoder,
      ffmpegVersao: bins.ffmpegVersao || null,
      config: {
        maxUploadMB: cfg.MAX_UPLOAD_MB,
        maxClipMinutes: cfg.MAX_CLIP_MINUTES,
        maxRenderJobs: cfg.MAX_RENDER_JOBS,
      },
      faltando: bins.faltando,
    });
  });

  // Placeholder do frontend até a fase da interface
  app.get('/', (req, res, next) => {
    const index = path.join(cfg.PUBLIC_DIR, 'index.html');
    if (fs.existsSync(index)) return res.sendFile(index);
    res.type('html').send(
      '<h1 style="font-family:sans-serif">FreeClip</h1>' +
      '<p style="font-family:sans-serif">Servidor no ar! Teste <a href="/api/health">/api/health</a>.</p>'
    );
  });

  // Tratamento de erros amigável (nunca mostra stack trace ao usuário)
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error('[erro]', err.message);
    if (res.headersSent) return;
    if (err.type === 'entity.too.large' || err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ erro: `Arquivo muito grande. Limite: ${cfg.MAX_UPLOAD_MB} MB.` });
    }
    res.status(500).json({ erro: 'Algo deu errado no servidor. Tente novamente.' });
  });

  app.listen(cfg.PORT, () => {
    console.log(`🎬 FreeClip rodando em  http://localhost:${cfg.PORT}`);
    if (!bins.ok) {
      console.log(`⚠  Faltando: ${bins.faltando.join(', ')} — veja as instruções acima.`);
    }
    console.log('');
  });

  // Limpeza automática de clipes antigos (1x por hora + na inicialização)
  const store = require('./store');
  setTimeout(() => store.limparAntigos(cfg.CLEANUP_DAYS), 30000);
  setInterval(() => store.limparAntigos(cfg.CLEANUP_DAYS), 3600000).unref();
})().catch((e) => {
  console.error('Falha ao iniciar o FreeClip:', e.message);
  process.exit(1);
});
