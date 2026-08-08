# Complete Deployment & Publishing Guide for EduNova X

This guide explains how to take EduNova X and publish it across all requested platforms:
1. **Web App** (Vercel)
2. **Mobile App** (Play Store & App Store via Capacitor)
3. **Backend & AI Agent** (Render)
4. **Desktop App** (.exe via Electron)

I have already pre-configured the necessary tools in your codebase (`@capacitor` for mobile and `electron` for desktop) so you can run the commands directly!

---

## 1. Deploy the Backend & AI Engine to Render

Before deploying the frontend, you need your backend APIs live so you can connect them.

**Using Render Blueprints (Easiest)**
1. Go to the [Render Dashboard](https://dashboard.render.com).
2. Click **New** > **Blueprint**.
3. Connect your GitHub account and select this `edunova_x` repository.
4. Render will automatically read the `render.yaml` file in the root directory and set up all three services:
   - `edunova-api` (Express backend)
   - `edunova-signal` (WebRTC signaling)
   - `edunova-ai` (FastAPI AI Agent)
5. Fill in the required Environment Variables when prompted (e.g., `MONGO_URI` for your MongoDB connection).
6. Once deployed, copy the URLs for your API and Signal services (e.g., `https://edunova-api.onrender.com`).

---

## 2. Publish Web App to Vercel

With the backends live, you can deploy the web frontend.

1. Go to your [Vercel Dashboard](https://vercel.com/dashboard).
2. Click **Add New** > **Project** and import the `edunova_x` GitHub repository.
3. In the project settings, set the **Root Directory** to `frontend`.
4. Open the **Environment Variables** section and add:
   - `VITE_API_URL` = `https://<your-edunova-api-url>.onrender.com/api`
   - `VITE_SIGNAL_URL` = `https://<your-edunova-signal-url>.onrender.com`
5. Click **Deploy**. Vercel will build the Vite app and publish your web app globally.

---

## 3. Make Downloadable Mobile Apps (Play Store & App Store)

I have already initialized **Capacitor** in the `frontend` folder for you. Capacitor wraps your web app into native Android and iOS apps.

### Prerequisites (for your local PC)
- **Android**: Install [Android Studio](https://developer.android.com/studio).
- **iOS**: You need a Mac with [Xcode](https://developer.apple.com/xcode/) installed.

### Steps to Build Mobile Apps
Run these commands locally in the `frontend` directory:

1. Build your frontend code:
   ```bash
   cd frontend
   npm run build
   ```
2. Sync the built web files to the native apps:
   ```bash
   npx cap sync
   ```
3. Open the platforms in their respective IDEs to build and publish:
   - **For Android (.aab/.apk):**
     ```bash
     npx cap open android
     ```
     *(In Android Studio, go to Build > Generate Signed Bundle / APK to create the file for the Play Store.)*
   - **For iOS (App Store):**
     ```bash
     npx cap open ios
     ```
     *(In Xcode, use Product > Archive to submit to the App Store.)*

---

## 4. Make a Desktop `.exe` File (Windows)

I have configured **Electron** and **Electron Builder** in your `frontend/package.json` to generate desktop executables.

### Steps to Build the `.exe`
Run these commands locally in the `frontend` directory on your Windows PC:

1. Make sure dependencies are installed:
   ```bash
   cd frontend
   npm install
   ```
2. Run the Electron builder script:
   ```bash
   npm run electron:build
   ```
3. Wait for the build to finish.
4. Your `.exe` installer will be generated inside the `frontend/dist-electron` folder! You can distribute this file for Windows users to install EduNova X.

> **Note:** If you want to build for Mac (`.dmg`), run the same command on a macOS machine. For Linux (`.AppImage`), run it on Linux.
