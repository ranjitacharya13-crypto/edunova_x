## 🤖 EduNova Autonomous AI Agent

EduNova now includes a goal-oriented learning and research agent with dynamic
tool selection, iterative observation/replanning, real source tracking, SSRF
protection, bounded execution, authenticated API access, and safe streamed
statuses. It answers stable learning questions directly and decides for itself
when current web research is necessary.

See **[AGENT_ARCHITECTURE.md](./AGENT_ARCHITECTURE.md)** for configuration,
API examples, security controls, deployment details, and tests.

## 📦 One-Step Installation

EduNova X is now available as a globally installable CLI tool or a direct-download package.

### Option 1: Global Installation (via npm)
```bash
# Clone the repo
git clone https://github.com/ranjitacharya13-crypto/edunova_x.git
cd edunova_x

# Run the setup script (Mac/Linux)
chmod +x setup.sh && ./setup.sh

# Run the setup script (Windows)
setup.bat

# (Optional) Install globally to use 'edunova-x' command
npm install -g .
```

### Option 2: Direct Download
1.  **Download** the `edunova-x-installer.zip` from the [Latest Release](https://github.com/ranjitacharya13-crypto/edunova_x/releases/latest).
2.  **Extract** the ZIP file.
3.  **Run** the `setup.sh` or `setup.bat` depending on your OS.
4.  **Configure** your environment in `server/.env`.

### 🚀 Starting the App
After setup, simply type:
```bash
edunova-x
```
This will launch the Frontend, Backend, Signaling, and AI Engine simultaneously.

## 🛠 Prerequisites
... (existing content)
... (existing content)
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
