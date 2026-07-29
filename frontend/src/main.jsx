import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import LiveRoom from "./pages/LiveRoom.jsx";
import './index.css'

const isLiveRoomRoute =
  typeof window !== "undefined" && /^\/live\/[^/]+/.test(window.location.pathname);

createRoot(document.getElementById("root")).render(
  isLiveRoomRoute ? <LiveRoom /> : <App />
);
