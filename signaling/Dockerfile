# EduNova WebRTC signaling (Socket.IO)
FROM node:20-alpine

WORKDIR /app

COPY package.json ./
# No lockfile in this folder — use npm install
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
# Render/Railway inject PORT at runtime (defaults to 5000 locally)
EXPOSE 5000

CMD ["node", "index.js"]
