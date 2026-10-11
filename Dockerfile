# FreeClip — deploy com processo longo + disco (NÃO funciona em serverless/Vercel)
FROM node:20-slim

# ffmpeg (render) + python + yt-dlp (download da Kick) via gerenciadores oficiais
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg python3 python3-pip \
  && pip install --no-cache-dir --break-system-packages yt-dlp \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependências primeiro (aproveita o cache de build do Docker)
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

# Código (bin/ e data/ são criados em runtime; .dockerignore tira o resto)
COPY . .
RUN mkdir -p data bin

# Plataformas (Render/Railway/Fly) injetam a porta via $PORT
ENV PORT=3000
EXPOSE 3000

# Health check: /api/health (ffmpeg + yt-dlp + encoder)
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
