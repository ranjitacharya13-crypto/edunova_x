const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

// Root status route for browser inspection
app.get('/', (req, res) => {
  res.json({
    success: true,
    service: "edunova-signal",
    status: "online",
    message: "WebRTC & Socket.io Signaling Server is running."
  });
});

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

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
