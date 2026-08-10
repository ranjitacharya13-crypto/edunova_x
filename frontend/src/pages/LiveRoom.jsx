import React, { useEffect, useMemo, useRef, useState } from "react";
import { io } from "socket.io-client";

const defaultSignalUrl = (() => {
  const configured = import.meta.env.VITE_SIGNAL_URL;
  if (configured) return configured;
  if (typeof window === "undefined") return "";
  // DEV: same-origin via the Vite proxy (/socket.io -> local backend).
  // PROD: if VITE_SIGNAL_URL was not set at build time, fall back to the
  // deployed Express API origin. This service also hosts Socket.IO signaling.
  if (import.meta.env.PROD) return "https://edunova-api-y3rx.onrender.com";
  return window.location.origin;
})();

function normalizeRoom(room) {
  return String(room || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function getRoomIdFromPath() {
  if (typeof window === "undefined") return "";
  const raw = window.location.pathname.replace(/^\/live\//, "");
  return normalizeRoom(decodeURIComponent(raw));
}

function getIceServers() {
  const turnUrl = import.meta.env.VITE_TURN_URL;
  if (turnUrl) {
    return [
      { urls: "stun:stun.l.google.com:19302" },
      {
        urls: turnUrl,
        username: import.meta.env.VITE_TURN_USERNAME,
        credential: import.meta.env.VITE_TURN_CREDENTIAL,
      },
    ];
  }
  return [{ urls: "stun:stun.l.google.com:19302" }];
}

function IconMic({ off }) {
  return <span>{off ? "Mic Off" : "Mic"}</span>;
}
function IconCam({ off }) {
  return <span>{off ? "Cam Off" : "Cam"}</span>;
}
function IconScreen({ on }) {
  return <span>{on ? "Stop Share" : "Share"}</span>;
}
function IconChat() {
  return <span>Chat</span>;
}
function IconFs({ on }) {
  return <span>{on ? "Exit Fullscreen" : "Fullscreen"}</span>;
}

function VideoTile({ stream, label, muted, showYouBadge }) {
  const videoRef = useRef(null);

  useEffect(() => {
    if (!videoRef.current) return;
    videoRef.current.srcObject = stream || null;
    const p = videoRef.current.play?.();
    if (p && typeof p.catch === "function") p.catch(() => {});
  }, [stream]);

  return (
    <div className="relative rounded-xl overflow-hidden border border-white/10 bg-black">
      <video ref={videoRef} autoPlay playsInline muted={muted} className="w-full h-full object-cover min-h-[220px]" />
      <div className="absolute left-3 bottom-3 text-xs px-2 py-1 rounded-full bg-black/60 border border-white/15">
        {label}
      </div>
      {showYouBadge ? (
        <div className="absolute right-3 top-3 text-xs px-2 py-1 rounded-full bg-emerald-500/20 text-emerald-200 border border-emerald-400/30">
          You
        </div>
      ) : null}
    </div>
  );
}

export default function LiveRoom() {
  const roomId = useMemo(() => getRoomIdFromPath(), []);
  const pcRef = useRef(null);
  const socketRef = useRef(null);
  const pendingIceRef = useRef([]);
  const localStreamRef = useRef(null);
  const cameraTrackRef = useRef(null);
  const screenTrackRef = useRef(null);

  const [localStream, setLocalStream] = useState(null);
  const [remoteStreams, setRemoteStreams] = useState([]);
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(true);
  const [isSharing, setIsSharing] = useState(false);
  const [showChat, setShowChat] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const participantCount = 1 + remoteStreams.length;

  const createPC = () => {
    const pc = new RTCPeerConnection({ iceServers: getIceServers() });
    pc.onicecandidate = (e) => {
      if (!e.candidate || !socketRef.current) return;
      socketRef.current.emit("ice-candidate", { room: roomId, candidate: e.candidate });
    };
    pc.ontrack = (e) => {
      const stream = e.streams?.[0];
      if (!stream) return;
      setRemoteStreams((prev) => (prev.some((s) => s.id === stream.id) ? prev : [...prev, stream]));
    };
    return pc;
  };

  const ensureLocalMedia = async () => {
    if (localStreamRef.current) return localStreamRef.current;
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    localStreamRef.current = stream;
    cameraTrackRef.current = stream.getVideoTracks()[0] || null;
    setLocalStream(stream);
    return stream;
  };

  const attachTracks = (pc, stream) => {
    const existing = pc.getSenders().map((s) => s.track).filter(Boolean);
    stream.getTracks().forEach((track) => {
      if (!existing.includes(track)) pc.addTrack(track, stream);
    });
  };

  const flushPendingIce = async () => {
    const pc = pcRef.current;
    if (!pc?.remoteDescription) return;
    const pending = pendingIceRef.current;
    pendingIceRef.current = [];
    for (const candidate of pending) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await pc.addIceCandidate(candidate);
      } catch {
        // ignore bad candidates
      }
    }
  };

  const ensureFullscreen = async () => {
    try {
      await document.documentElement.requestFullscreen();
      setIsFullscreen(true);
    } catch {
      setIsFullscreen(false);
    }
  };

  const cleanup = async ({ closeWindow = false } = {}) => {
    try {
      if (screenTrackRef.current) screenTrackRef.current.stop();
      screenTrackRef.current = null;
    } catch {}

    try {
      if (pcRef.current) {
        pcRef.current.onicecandidate = null;
        pcRef.current.ontrack = null;
        pcRef.current.close();
      }
    } catch {}
    pcRef.current = null;

    try {
      if (localStreamRef.current) localStreamRef.current.getTracks().forEach((t) => t.stop());
    } catch {}
    localStreamRef.current = null;

    try {
      if (socketRef.current) socketRef.current.disconnect();
    } catch {}
    socketRef.current = null;

    setRemoteStreams([]);
    setLocalStream(null);

    if (document.fullscreenElement) {
      try {
        await document.exitFullscreen();
      } catch {}
    }

    if (closeWindow && typeof window !== "undefined") {
      window.close();
    }
  };

  const leaveCall = async () => {
    await cleanup({ closeWindow: true });
  };

  const toggleMic = () => {
    const stream = localStreamRef.current;
    if (!stream) return;
    const next = !micOn;
    stream.getAudioTracks().forEach((t) => {
      // eslint-disable-next-line no-param-reassign
      t.enabled = next;
    });
    setMicOn(next);
  };

  const toggleCam = () => {
    const stream = localStreamRef.current;
    if (!stream) return;
    const next = !camOn;
    stream.getVideoTracks().forEach((t) => {
      // eslint-disable-next-line no-param-reassign
      t.enabled = next;
    });
    setCamOn(next);
  };

  const toggleScreenShare = async () => {
    const pc = pcRef.current;
    const stream = localStreamRef.current;
    if (!pc || !stream) return;

    if (isSharing) {
      if (screenTrackRef.current) {
        try {
          screenTrackRef.current.stop();
        } catch {}
      }
      screenTrackRef.current = null;
      const camTrack = cameraTrackRef.current;
      const sender = pc.getSenders().find((s) => s.track?.kind === "video");
      if (sender && camTrack) await sender.replaceTrack(camTrack);
      setIsSharing(false);
      return;
    }

    const displayStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    const screenTrack = displayStream.getVideoTracks()[0];
    if (!screenTrack) return;
    screenTrackRef.current = screenTrack;
    screenTrack.onended = () => {
      toggleScreenShare().catch(() => {});
    };
    const sender = pc.getSenders().find((s) => s.track?.kind === "video");
    if (sender) await sender.replaceTrack(screenTrack);
    setIsSharing(true);
  };

  const toggleFullscreen = async () => {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
      setIsFullscreen(false);
      return;
    }
    await ensureFullscreen();
  };

  useEffect(() => {
    if (!roomId) return undefined;

    const onFsChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    const onEsc = async (e) => {
      if (e.key === "Escape" && document.fullscreenElement) {
        try {
          await document.exitFullscreen();
        } catch {}
      }
    };

    document.addEventListener("fullscreenchange", onFsChange);
    window.addEventListener("keydown", onEsc);

    let cancelled = false;
    const socket = io(defaultSignalUrl, { transports: ["websocket"] });
    socketRef.current = socket;

    const init = async () => {
      await ensureFullscreen();
      const stream = await ensureLocalMedia();
      if (cancelled) return;

      const pc = createPC();
      pcRef.current = pc;
      attachTracks(pc, stream);

      socket.emit("join", roomId);

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit("offer", { room: roomId, offer });
    };

    const onOffer = async ({ offer }) => {
      try {
        if (!offer) return;
        let pc = pcRef.current;
        if (!pc) {
          pc = createPC();
          pcRef.current = pc;
          const stream = await ensureLocalMedia();
          attachTracks(pc, stream);
        }
        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        await flushPendingIce();
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit("answer", { room: roomId, answer });
      } catch {}
    };

    const onAnswer = async ({ answer }) => {
      try {
        if (!answer || !pcRef.current) return;
        await pcRef.current.setRemoteDescription(new RTCSessionDescription(answer));
        await flushPendingIce();
      } catch {}
    };

    const onIce = async ({ candidate }) => {
      try {
        if (!candidate) return;
        const pc = pcRef.current;
        if (!pc || !pc.remoteDescription) {
          pendingIceRef.current.push(candidate);
          return;
        }
        await pc.addIceCandidate(candidate);
      } catch {}
    };

    const onPeerJoined = async () => {
      try {
        const pc = pcRef.current;
        if (!pc || pc.signalingState !== "stable") return;
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit("offer", { room: roomId, offer });
      } catch {}
    };

    socket.on("offer", onOffer);
    socket.on("answer", onAnswer);
    socket.on("ice-candidate", onIce);
    socket.on("peer-joined", onPeerJoined);

    init().catch(() => {});

    return () => {
      cancelled = true;
      socket.off("offer", onOffer);
      socket.off("answer", onAnswer);
      socket.off("ice-candidate", onIce);
      socket.off("peer-joined", onPeerJoined);
      document.removeEventListener("fullscreenchange", onFsChange);
      window.removeEventListener("keydown", onEsc);
      cleanup({ closeWindow: false }).catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId]);

  if (!roomId) {
    return (
      <div className="min-h-screen bg-[#111827] text-white flex items-center justify-center">
        Invalid room
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#111827] text-white flex flex-col">
      <header className="h-14 px-4 border-b border-white/10 flex items-center justify-between">
        <div className="text-sm sm:text-base font-medium truncate">Room: {roomId}</div>
        <div className="flex items-center gap-3">
          <div className="text-xs text-white/70">{participantCount} participants</div>
          <button
            onClick={toggleFullscreen}
            className="px-3 py-1.5 rounded-xl bg-white/10 hover:bg-white/20 transition"
          >
            <IconFs on={isFullscreen} />
          </button>
          <button
            onClick={leaveCall}
            className="h-10 w-10 rounded-full bg-red-600 hover:bg-red-500 transition flex items-center justify-center"
            title="Leave"
          >
            X
          </button>
        </div>
      </header>

      <main className="flex-1 p-4 pb-24">
        <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 auto-rows-fr">
          <VideoTile stream={localStream} label="You" muted showYouBadge />
          {remoteStreams.map((stream, idx) => (
            <VideoTile key={stream.id || idx} stream={stream} label={`Participant ${idx + 1}`} muted={false} />
          ))}
        </div>
      </main>

      {showChat ? (
        <aside className="absolute right-2 sm:right-4 top-16 bottom-24 w-[min(92vw,360px)] rounded-xl border border-white/10 bg-black/40 backdrop-blur p-3">
          <div className="text-sm font-medium">Chat</div>
          <div className="text-xs text-white/60 mt-2">Chat panel ready</div>
        </aside>
      ) : null}

      <div className="fixed left-1/2 -translate-x-1/2 bottom-3 sm:bottom-5 z-30 w-[calc(100%-16px)] sm:w-auto">
        <div className="flex items-center justify-center gap-1.5 sm:gap-2 bg-black/50 border border-white/10 rounded-full px-2.5 sm:px-3 py-2 backdrop-blur">
          <button
            onClick={toggleMic}
            className={`px-3 py-2 rounded-full transition ${micOn ? "bg-white/10 hover:bg-white/20" : "bg-red-500/80 hover:bg-red-500"}`}
          >
            <IconMic off={!micOn} />
          </button>
          <button
            onClick={toggleCam}
            className={`px-3 py-2 rounded-full transition ${camOn ? "bg-white/10 hover:bg-white/20" : "bg-red-500/80 hover:bg-red-500"}`}
          >
            <IconCam off={!camOn} />
          </button>
          <button onClick={toggleScreenShare} className="px-3 py-2 rounded-full bg-white/10 hover:bg-white/20 transition">
            <IconScreen on={isSharing} />
          </button>
          <button
            onClick={() => setShowChat((v) => !v)}
            className="px-3 py-2 rounded-full bg-white/10 hover:bg-white/20 transition"
          >
            <IconChat />
          </button>
          <button
            onClick={leaveCall}
            className="px-4 py-2 rounded-full bg-red-600 hover:bg-red-500 transition"
          >
            Leave
          </button>
        </div>
      </div>
    </div>
  );
}
