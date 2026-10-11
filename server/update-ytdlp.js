// ============================================================================
// update-ytdlp.js — Atualiza o yt-dlp para ./bin (npm run update-ytdlp)
// ----------------------------------------------------------------------------
// O yt-dlp quebra de vez em quando quando os sites mudam. Rode este comando
// para baixar a versão mais recente sem mexer no resto do FreeClip.
// ============================================================================
const fs = require('fs');
const { baixarYtDlp, funciona, binPath } = require('./binman');

(async () => {
  try {
    const caminho = await baixarYtDlp();
    tornarExec(caminho);
    const versao = funciona(caminho) || 'desconhecida';
    console.log(`\n✔  yt-dlp atualizado com sucesso!\n   ${versao}\n`);
  } catch (e) {
    console.error(`\n✖  Falha ao atualizar o yt-dlp: ${e.message}`);
    console.error('   Você também pode baixar manualmente em https://github.com/yt-dlp/yt-dlp/releases');
    console.error(`   e salvar como ${binPath('yt-dlp')}\n`);
    process.exit(1);
  }

  function tornarExec(p) {
    if (process.platform !== 'win32') {
      try { fs.chmodSync(p, 0o755); } catch { /* ignore */ }
    }
  }
})();
