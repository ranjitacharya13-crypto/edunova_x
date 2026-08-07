# EduNova API + Socket.IO server
FROM node:20-bookworm-slim

# System libs needed by pdf-thumbnail (GraphicsMagick + Ghostscript).
# sharp installs prebuilt libvips binaries via npm — no manual install needed.
RUN apt-get update && apt-get install -y --no-install-recommends \
    graphicsmagick \
    ghostscript \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install production deps first for better layer caching
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
# Render/Railway inject PORT at runtime (server defaults to 4000 locally)
EXPOSE 4000

CMD ["node", "server.js"]
