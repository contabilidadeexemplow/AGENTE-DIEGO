# ROBÔ DO AGRO FÁCIL no Render do cliente: só a API e as funções no SIARE.
# As telas são as do site do cliente (Lovable); por isso aqui não se compila
# aplicativo nenhum, e o SO_API desliga a entrega de páginas.
FROM node:22-slim
# O Chromium vem do apt (bibliotecas casadas com o sistema), não do download do
# Puppeteer: o binário baixado quebra em imagem slim por falta de biblioteca.
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium tzdata fonts-liberation ca-certificates \
    && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    TZ=America/Sao_Paulo \
    HEADLESS=true \
    SO_API=1 \
    DIR_DADOS=/app/dados
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY *.mjs ./
RUN mkdir -p /app/dados
EXPOSE 10000
CMD ["node", "servidor.mjs"]
