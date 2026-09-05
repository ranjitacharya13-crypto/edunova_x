import { io } from "socket.io-client";
import { API_ORIGIN } from "./api";

// ---------------------------------------------------------------------------
// Shared Socket.IO signaling connection.
//
// Why this exists: LiveView used to create a module-level socket on import, so
// EVERY page load opened a WebSocket to the signaling server and kept it open
// forever — even for users who never join a live class. When the browser put
// the page into the Back-Forward Cache, Chrome killed the socket mid-flight
// and logged:
//
//   WebSocket connection to wss://…/socket.io/… failed:
//   Page entered Back-Forward Cache.
//
// repeatedly in the console. LiveRoom additionally opened a second, duplicate
// connection per mount.
//
// This module gives both components ONE lazily-created connection with a
// reference-counted lifecycle and explicit Back-Forward Cache handling:
//   - the socket is only created when a live-class surface actually needs it;
//   - `pagehide` with `event.persisted === true` (page enters the BFC cache)
//     disconnects cleanly BEFORE the browser force-kills the transport, which
//     removes the console error and stale-socket state;
//   - `pageshow` with `event.persisted === true` (page restored) reconnects
//     immediately when a consumer is still mounted;
//   - the last consumer to unmount releases the connection entirely.
//
// NOTE: the AI chat intentionally does NOT use this socket. EduNova AI runs
// over authenticated HTTP/SSE against the Express API (/api/ai/…), so AI
// keeps working regardless of signaling/WebSocket state.
// ---------------------------------------------------------------------------

function resolveSignalUrl() {
  const configured = import.meta.env.VITE_SIGNAL_URL;
  if (configured) return String(configured).replace(/\/+$/, "");

  if (typeof window === "undefined") return "";

  // Default: the Express API service hosts Socket.IO signaling + chat on the
  // SAME origin as the REST API (see render.yaml), so fall back to the API
  // origin (VITE_API_URL minus its /api suffix).
  if (import.meta.env.PROD) {
    return API_ORIGIN || "https://edunova-api-y3rx.onrender.com";
  }
  // DEV (Vite): same-origin via the Vite proxy for `/socket.io`.
  return window.location.origin;
}

let sharedSocket = null;
let refCount = 0;
let lifecycleBound = false;

function handlePageHide(event) {
  // Page is entering the Back-Forward Cache: close the transport cleanly so
  // the browser never has to kill a live WebSocket (source of the console
  // errors). Non-bfcache navigations keep the socket connected — it will be
  // torn down by the normal unmount path anyway.
  if (event?.persisted && sharedSocket && sharedSocket.connected) {
    try {
      sharedSocket.disconnect();
    } catch {
      // never let teardown throw
    }
  }
}

function handlePageShow(event) {
  // Page was restored from the Back-Forward Cache: reconnect instantly if a
  // consumer still needs the socket. Prevents waiting for Socket.IO's own
  // heartbeat timeout to notice the dead transport.
  if (event?.persisted && sharedSocket && refCount > 0 && sharedSocket.disconnected) {
    try {
      sharedSocket.connect();
    } catch {
      // reconnect failures are retried by Socket.IO's manager
    }
  }
}

function bindLifecycleOnce() {
  if (lifecycleBound || typeof window === "undefined") return;
  window.addEventListener("pagehide", handlePageHide);
  window.addEventListener("pageshow", handlePageShow);
  lifecycleBound = true;
}

/**
 * Acquire the shared signaling socket (creating it on first use).
 * Every caller MUST call `releaseSignalSocket()` when its component unmounts.
 */
export function acquireSignalSocket() {
  bindLifecycleOnce();
  if (!sharedSocket) {
    sharedSocket = io(resolveSignalUrl(), {
      // Long-polling first, upgrade to WebSocket when the host/network allows
      // it — WebSocket-only fails outright during Render cold starts.
      transports: ["polling", "websocket"],
    });
  }
  refCount += 1;
  if (sharedSocket.disconnected) {
    try {
      sharedSocket.connect();
    } catch {
      // Socket.IO's manager retries with backoff
    }
  }
  return sharedSocket;
}

/**
 * Release one acquire() reference. The connection is closed once the last
 * consumer unmounts, so idle pages hold no WebSocket (and therefore cannot
 * leak bfcache errors for users who never open a live class).
 */
export function releaseSignalSocket() {
  refCount = Math.max(0, refCount - 1);
  if (refCount === 0 && sharedSocket && sharedSocket.connected) {
    try {
      sharedSocket.disconnect();
    } catch {
      // never let teardown throw
    }
  }
}

/** Test/diagnostic helper. */
export function signalSocketConnectionState() {
  if (!sharedSocket) return "not_created";
  if (sharedSocket.connected) return "connected";
  if (sharedSocket.disconnected) return "disconnected";
  return "connecting";
}
