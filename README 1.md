Edunova_X - Ready-to-import project
Structure: frontend (React+Vite+Tailwind), server (Express+MongoDB+JWT+GridFS+Socket.IO). `signaling/` is kept but signaling now runs inside `server/` by default.
Demo DB: local MongoDB at mongodb://127.0.0.1:27017/edunova_jwt
Demo accounts:
  teacher@edunova.com / 123456
  student@edunova.com / 123456

How to run:
1. Ensure MongoDB daemon is running locally.
2. From project-root run: npm run install-all
3. From project-root run: npm start
4. Open http://localhost:5173

Join from another PC/phone (student + teacher):
- Recommended (ngrok / multi-device): run `npm run start:ngrok` then start ngrok for port `4000` (the backend serves the built frontend + Socket.IO signaling on the same origin).
- Open the app on both devices using the same URL (LAN IP for port `4000` or the ngrok URL for `4000`). Do not use `localhost` on the student device.

Notes:
 - Backend uses sharp and pdf-thumbnail for thumbnails. They may require native dependencies on your system.
 - After first run, register new users or use demo accounts.
 - If mobile/4G networks still can’t connect video, you likely need a TURN server. Set `VITE_TURN_URL`, `VITE_TURN_USERNAME`, `VITE_TURN_CREDENTIAL` (or `VITE_ICE_SERVERS_JSON`) in `frontend/.env` and rebuild.
