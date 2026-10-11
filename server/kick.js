// ============================================================================
// kick.js — Validação e resolução de links de clipes da Kick
// ----------------------------------------------------------------------------
// Aceita os formatos:
//   https://kick.com/{canal}/clips/clip_XXXXXXXX
//   https://kick.com/{canal}?clip=clip_XXXXXXXX
//   https://kick.com/clip/clip_XXXXXXXX
//   https://clips.kick.com/...
// Segurança: só aceita host kick.com ou subdomínio (impede SSRF).
// ============================================================================
const { executar } = require('./binman');

// Padrão do ID de clipe da Kick: "clip_" seguido de caracteres alfanuméricos
const CLIP_ID_RE = /^clip_[a-zA-Z0-9]{6,64}$/;

/** Erro amigável padrão quando nenhum método consegue baixar o clipe */
const ERRO_DOWNLOAD =
  'Não foi possível baixar este clipe. Atualize o yt-dlp (npm run update-ytdlp) ou envie o arquivo manualmente.';

/**
 * Valida a URL e extrai { clipId, canal, urlCanonica }.
 * Lança Error com mensagem amigável em português se for inválida.
 */
function validarUrlKick(urlBruta) {
  if (typeof urlBruta !== 'string' || !urlBruta.trim()) {
    throw new Error('Cole um link de clipe da Kick para continuar.');
  }
  let url;
  try {
    url = new URL(urlBruta.trim());
  } catch {
    throw new Error('Este link não parece válido. Verifique e tente novamente.');
  }

  // Whitelist de domínios: somente kick.com e subdomínios (impede SSRF)
  const host = url.hostname.toLowerCase();
  if (host !== 'kick.com' && !host.endsWith('.kick.com')) {
    throw new Error('Só aceitamos links da Kick (kick.com). Outros sites não são suportados.');
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Protocolo inválido. Use um link https:// da Kick.');
  }

  const partes = url.pathname.split('/').filter(Boolean);
  let clipId = null;
  let canal = null;

  // Formato: kick.com/{canal}/clips/{clipId}  ou  kick.com/clip/{clipId}
  const idx = partes.findIndex((p) => p.toLowerCase() === 'clips' || p.toLowerCase() === 'clip');
  if (idx >= 0 && partes[idx + 1]) {
    clipId = partes[idx + 1];
    if (idx > 0) canal = partes[0];
  }
  // Formato: kick.com/{canal}?clip={clipId}
  if (!clipId && url.searchParams.get('clip')) {
    clipId = url.searchParams.get('clip');
    if (partes[0]) canal = partes[0];
  }
  // Formato residual: algum path que termine com o id
  if (!clipId && partes.length) {
    const candidato = partes[partes.length - 1];
    if (CLIP_ID_RE.test(candidato)) clipId = candidato;
  }

  if (!clipId || !CLIP_ID_RE.test(clipId)) {
    throw new Error('Não encontrei o ID do clipe neste link. Ex.: kick.com/canal/clips/clip_XXXX');
  }

  const urlCanonica = canal
    ? `https://kick.com/${canal}/clips/${clipId}`
    : `https://kick.com/clip/${clipId}`;

  return { clipId, canal, urlCanonica };
}

/**
 * Passo 1 da resolução: yt-dlp --dump-json para obter metadados.
 * Retorna { titulo, duracao } ou null em caso de falha.
 */
async function metadadosViaYtDlp(ytdlpPath, url) {
  const { code, stdout } = await executar(ytdlpPath, [
    '--dump-json', '--no-playlist', '--no-warnings', url,
  ], { timeout: 60000 });
  if (code !== 0) return null;
  try {
    const info = JSON.parse(stdout);
    return {
      titulo: (info.title || 'Clipe da Kick').slice(0, 140),
      duracao: Number(info.duration) || null,
      largura: Number(info.width) || null,
      altura: Number(info.height) || null,
    };
  } catch {
    return null;
  }
}

/**
 * Passo 2 (fallback): API pública da Kick usada pelo próprio site.
 * Atenção: o campo do vídeo pode ser clip_url OU video_url (muda com o tempo).
 */
async function infoViaApiKick(clipId) {
  const resp = await fetch(`https://kick.com/api/v2/clips/${clipId}`, {
    headers: {
      // Headers de navegador real para não sermos bloqueados de cara
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      'Accept': 'application/json',
      'Referer': 'https://kick.com/',
    },
    signal: AbortSignal.timeout(20000),
  });
  if (!resp.ok) throw new Error(`Kick respondeu HTTP ${resp.status}`);
  const json = await resp.json();
  const clip = json.clip || json; // a API costuma envelopar em { clip: {...} }
  const videoUrl = clip.clip_url || clip.video_url || clip.videoUrl || null;
  if (!videoUrl || !/^https:\/\//.test(videoUrl)) throw new Error('URL do vídeo não encontrada no JSON');
  return {
    videoUrl,
    titulo: (clip.title || 'Clipe da Kick').slice(0, 140),
    duracao: Number(clip.duration) / 1000 || Number(clip.duration) || null, // às vezes vem em ms
  };
}

module.exports = { validarUrlKick, metadadosViaYtDlp, infoViaApiKick, ERRO_DOWNLOAD };
