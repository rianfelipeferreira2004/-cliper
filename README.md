# 🎬 FreeClip

Clone **gratuito e self-hosted** do Streamlabs Cross Clip: transforma clipes da **Kick** (ou qualquer vídeo seu) em vídeos verticais **9:16** para TikTok, Reels e Shorts.

- ✅ 100% gratuito — sem conta, sem chave de API, sem nuvem, sem pagamento
- ✅ Roda tudo localmente: `npm install && npm start` → http://localhost:3000
- ✅ Preview de saída **em tempo real** (canvas, sem renderizar nada)
- ✅ Render rápido em **um único comando ffmpeg** (com aceleração de GPU quando disponível)
- ✅ Interface em português do Brasil, tema escuro com amarelo `#FFD83B` e rosa `#E8458B`

---

## Requisitos

- **Node.js 20+** (`node --version`)
- **~300 MB livres** na primeira execução (o servidor baixa `ffmpeg`, `ffprobe` e `yt-dlp` sozinho para a pasta `./bin`)
- Navegador moderno (Chrome ou Edge recomendados)
- Para compilar rápido: qualquer CPU com 4+ núcleos; com GPU NVIDIA/Intel/AMD/Apple o render usa aceleração por hardware automaticamente

## Como rodar

```bash
npm install
npm start
```

Abra **http://localhost:3000**. Na primeira vez, o terminal mostra o download do `yt-dlp` (~17 MB) e do `ffmpeg` (~110 MB, só Windows/Mac — no Linux, instale pelo gerenciador de pacotes, veja abaixo).

### Comandos úteis

| Comando | Para que serve |
|---|---|
| `npm start` | Inicia o servidor (porta 3000) |
| `npm run update-ytdlp` | **Atualiza o yt-dlp** (rode quando a Kick parar de baixar) |

### Configuração (opcional)

Copie `.env.example` para `.env` e ajuste:

| Variável | Padrão | Significado |
|---|---|---|
| `PORT` | 3000 | Porta do servidor |
| `MAX_UPLOAD_MB` | 2048 | Limite de upload (2 GB) |
| `MAX_CLIP_MINUTES` | 3 | Aviso de duração máxima na timeline |
| `MAX_RENDER_JOBS` | 2 | Compilações simultâneas |
| `CLEANUP_DAYS` | 7 | Apaga automaticamente clipes mais velhos que isso |
| `RESOLVE_RATE_LIMIT` | 10 | Resoluções de link da Kick por minuto, por IP |

---

## Como usar

1. **Criar clipe** → cole o link de um clipe da Kick **ou** arraste um vídeo (MP4, MOV, WEBM, MKV).
2. No **editor**, arraste as caixas coloridas sobre o vídeo de entrada; o **preview 9:16** atualiza na hora.
3. Escolha o **layout** (tela cheia, 50/50, 60/40, 40/60, webcam sobreposta, personalizado).
4. Opcional: escreva uma **headline** na aba Configurações — texto em fonte Anton com contorno preto e sombra, flutuando sobre o vídeo na posição Y que você escolher (0 = topo, 1920 = base). Vazio = sem headline.
5. Marque o trecho na **timeline** (`I` = início, `O` = fim, `Espaço` = play, setas = ±1 frame).
6. **Compilar** → escolha título, FPS e qualidade → acompanhe a barra → **Baixar**.

A compilação continua no servidor mesmo se você fechar o modal ou sair da página.

---

## Formatos de link da Kick aceitos

- `https://kick.com/{canal}/clips/clip_XXXXXXXX`
- `https://kick.com/{canal}?clip=clip_XXXXXXXX`
- `https://kick.com/clip/clip_XXXXXXXX`
- `https://clips.kick.com/...`

## O que fazer se a Kick bloquear o download

A Kick usa proteção do Cloudflare, que às vezes barra downloads automáticos. Se aparecer a mensagem **"Não foi possível baixar este clipe"**:

1. Atualize o yt-dlp (a causa mais comum):
   ```bash
   npm run update-ytdlp
   ```
   Depois tente o link de novo.
2. Se ainda falhar: abra o clipe no navegador, baixe o vídeo (`...` → Download, ou use a extensão da sua preferência) e envie pelo botão **Upload de vídeo** do FreeClip — o editor funciona igual, 100% offline a partir daí.
3. Como último recurso, grave a tela e envie o arquivo.

## ffmpeg no Linux

O download automático cobre Windows e macOS. No Linux, instale pelo sistema:

```bash
# Debian/Ubuntu
sudo apt install ffmpeg
# Fedora
sudo dnf install ffmpeg
```

(O FreeClip usa o `ffmpeg`/`ffprobe` do sistema automaticamente quando não há cópia em `./bin`.)

---

## Como funciona (resumo técnico)

- **Backend:** Node 20 + Express. Downloads via `yt-dlp` (com fallback para a API pública da Kick + `ffmpeg`/`fetch`), metadados com `ffprobe`, biblioteca em JSON no disco (`data/clips.json`), vídeos servidos com **Range requests** (seek instantâneo).
- **Editor:** regiões em coordenadas normalizadas (0–1), proporção travada à do slot de saída, arraste/redimensionamento com `interact.js`, preview 9:16 via `<canvas>` + `requestAnimationFrame` (`drawImage` recortado por região).
- **Render:** **um único `ffmpeg`** (`crop → scale → vstack/overlay → drawtext → fps/scale → setsar=1 → yuv420p`), `-ss` antes do `-i` (seek rápido), coordenadas pares, fila com 2 jobs simultâneos, progresso real (`-progress pipe:1` → SSE), encoder por hardware com fallback para `libx264`, cancelamento com limpeza do parcial.
- **Detalhe importante:** o fundo sólido é gerado com `trim + drawbox + loop` finito a partir do próprio vídeo (e não com `color`/lavfi infinito), para a memória ficar estável mesmo em PCs modestos.
- **Headline:** texto via `drawtext` com a fonte Anton vendorizada em `public/fonts` (licença OFL, funciona offline); o texto vai em arquivo (`textfile`) e os caminhos no filtro são relativos, para acentos/aspas/`:` nunca quebrarem o parser no Windows.

## Estrutura

```
freeclip/
├── server/
│   ├── index.js        # bootstrap + health + estáticos
│   ├── config.js       # .env + padrões
│   ├── binman.js       # baixa ffmpeg/yt-dlp + detecta encoder GPU
│   ├── kick.js         # valida e resolve links da Kick
│   ├── store.js        # biblioteca (JSON em disco)
│   ├── update-ytdlp.js # npm run update-ytdlp
│   └── routes/
│       ├── clips.js    # resolve/upload/biblioteca/mídia com Range
│       └── render.js   # fila de render + SSE + cancelamento
├── public/
│   ├── index.html
│   ├── css/style.css
│   └── js/             # layouts, api, biblioteca, timeline, editor, compilar, app
├── bin/                # ffmpeg, ffprobe, yt-dlp (baixados sozinhos)
└── data/               # clips.json + vídeos, thumbs, saídas (locais)
```

## Licença

MIT — use, modifique e compartilhe à vontade.
