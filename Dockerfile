FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY server ./server
COPY web ./web

ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data \
    FONT_FILE=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf

VOLUME ["/data"]
EXPOSE 8080
CMD ["node", "server/index.js"]
