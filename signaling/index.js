const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
const allowedOrigins = (process.env.CORS_ORIGIN || [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'https://edunova-x.ranjitacharya13.workers.dev',
].join(',')).split(',').map(origin => origin.trim()).filter(Boolean);
const corsOptions = {
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('CORS origin not allowed'));
  },
  credentials: false,
};
app.use(cors(corsOptions));

// Health check for Render's load balancer (healthCheckPath: /health in render.yaml).
// Returns 200 + JSON without touching Socket.IO so the LB check never interferes
// with the WebRTC signaling traffic.
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'live', service: 'edunova-signal' });
});

// Root status route for browser inspection — explicit 200 so Render's default
// load balancer probe (/ ) also succeeds while Socket.IO keeps working.
app.get('/', (req, res) => {
  res.status(200).json({
    success: true,
    service: "edunova-signal",
    status: "online",
    message: "WebRTC & Socket.io Signaling Server is running."
  });
});

const server = http.createServer(app);
const io = new Server(server, { cors: corsOptions });

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
server.listen(PORT, '0.0.0.0', () => console.log('Signaling server running on port', PORT));
