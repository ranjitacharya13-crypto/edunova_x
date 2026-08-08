const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();

// CORS: the signaling endpoint must accept Socket.IO connections from the
// Vercel frontend (any *.vercel.app deployment), localhost/ngrok dev origins,
// and any explicit origins in CORS_ORIGINS. Non-browser probes (Render LB)
// have no Origin header and always pass.
function buildCorsOriginAllowlist() {
  const extra = String(process.env.CORS_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const exact = new Set([
    'http://localhost:5173',
    'http://localhost:3000',
    'http://localhost:8080',
    'http://localhost',
    'capacitor://localhost',
    'https://edunova-x.vercel.app',
    ...extra,
  ]);

  const patterns = [
    /^https:\/\/[a-z0-9-]+\.vercel\.app$/i,
    /^https?:\/\/[a-z0-9-]+\.ngrok(-free)?\.dev$/i,
    /^http:\/\/127\.0\.0\.1:\d+$/,
    /^http:\/\/localhost:\d+$/,
  ];

  return function corsOrigin(origin, callback) {
    if (!origin) return callback(null, false);
    if (exact.has(origin)) return callback(null, origin);
    for (const re of patterns) {
      if (re.test(origin)) return callback(null, origin);
    }
    return callback(null, false);
  };
}

app.use(cors({ origin: buildCorsOriginAllowlist(), credentials: false }));

// Universal health contract — Render LB probe (healthCheckPath: /health in
// render.yaml). Returns 200 + JSON without touching Socket.IO so the LB check
// never interferes with the WebRTC signaling traffic.
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', service: 'edunova-x-production' });
});

// Root status route — explicit 200 so Render's default load balancer probe (/)
// also succeeds while Socket.IO keeps working (fixes "Cannot GET /").
app.get('/', (req, res) => {
  res.status(200).json({
    success: true,
    service: "edunova-signal",
    status: "online",
    message: "WebRTC & Socket.io Signaling Server is running."
  });
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: buildCorsOriginAllowlist(),
    credentials: false,
    methods: ['GET', 'POST'],
  },
});

const CHAT_HISTORY_LIMIT = 200;
const roomChat = new Map(); // room -> [{ id, text, user, createdAt }]

function getRoomHistory(room) {
  if (!roomChat.has(room)) roomChat.set(room, []);
  return roomChat.get(room);
}

io.on('connection', socket => {
  console.log('client connected', socket.id);
  socket.on('join', (room) => {
    if (!room) return;
    socket.join(room);
    socket.to(room).emit('peer-joined', { id: socket.id });

    // send chat history to newly joined client
    const history = getRoomHistory(room);
    socket.emit('chat-history', { room, messages: history });
  });
  socket.on('offer', ({ room, offer }) => { socket.to(room).emit('offer', { offer }); });
  socket.on('answer', ({ room, answer }) => { socket.to(room).emit('answer', { answer }); });
  socket.on('ice-candidate', ({ room, candidate }) => { socket.to(room).emit('ice-candidate', { candidate }); });

  socket.on('chat-send', ({ room, text, user }) => {
    if (!room) return;
    const cleaned = String(text || '').trim();
    if (!cleaned) return;

    const message = {
      id: `${Date.now()}_${Math.random().toString(16).slice(2)}`,
      text: cleaned.slice(0, 1000),
      user: {
        id: user?.id || null,
        name: user?.name || 'User',
        role: user?.role || null,
      },
      createdAt: new Date().toISOString(),
    };

    const history = getRoomHistory(room);
    history.push(message);
    if (history.length > CHAT_HISTORY_LIMIT) history.splice(0, history.length - CHAT_HISTORY_LIMIT);

    io.to(room).emit('chat-message', { room, message });
  });

  socket.on('disconnect', () => console.log('client disconnected', socket.id));
});

const PORT = process.env.PORT || 5000;

// Friendly JSON 404 for any unknown route — never expose the raw HTML
// "Cannot GET …" page (previously seen in production logs).
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: "Not Found",
    hint: "This service exposes GET /health and GET /. Socket.IO signaling lives on /socket.io.",
  });
});

server.listen(PORT, '0.0.0.0', () => console.log('Signaling server running on port', PORT));
