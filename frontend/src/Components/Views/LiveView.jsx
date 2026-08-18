import React, { useEffect, useMemo, useRef, useState } from "react";
import { io } from "socket.io-client";
import { API, apiUrl, API_ORIGIN } from "../../api/api";

const defaultSignalUrl = (() => {
  const configured = import.meta.env.VITE_SIGNAL_URL;
  if (configured) return configured;

  if (typeof window === "undefined") return "";

  // Default: the Express API service hosts Socket.IO signaling + chat on the
  // SAME origin as the REST API (see render.yaml), so fall back to the API
  // origin (VITE_API_URL minus its /api suffix).
  // - DEV (Vite): same-origin via the Vite proxy for `/socket.io` -> local backend.
  // - PROD: VITE_SIGNAL_URL is only needed if signaling is deployed as a
  //   separate service; otherwise the API origin below is used.
  if (import.meta.env.PROD) {
    return API_ORIGIN || "https://edunova-api-y3rx.onrender.com";
  }
  return window.location.origin;
})();

const socket = io(defaultSignalUrl, { transports: ["websocket"] });

function normalizeRoom(room) {
  return String(room || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function getIceServers() {
  const json = import.meta.env.VITE_ICE_SERVERS_JSON;
  if (json) {
    try {
      const parsed = JSON.parse(json);
      if (Array.isArray(parsed) && parsed.length) return parsed;
    } catch {
      // ignore invalid JSON
    }
  }

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

function formatDuration(totalSeconds) {
  const s = Math.max(0, Number(totalSeconds || 0));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = Math.floor(s % 60);
  const mm = String(minutes).padStart(2, "0");
  const ss = String(seconds).padStart(2, "0");
  if (hours > 0) return `${hours}:${mm}:${ss}`;
  return `${minutes}:${ss}`;
}

function initialsFromName(name) {
  const cleaned = String(name || "").trim();
  if (!cleaned) return "?";
  const parts = cleaned.split(/\s+/).slice(0, 2);
  return parts.map((p) => p[0]?.toUpperCase()).join("");
}

function IconMic({ muted, className = "h-5 w-5" }) {
  return muted ? (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 1a3 3 0 0 0-3 3v6a3 3 0 0 0 5.5 1.5" />
      <path d="M15 10V4a3 3 0 0 0-5.7-1.2" />
      <path d="M19 11a7 7 0 0 1-14 0" />
      <path d="M12 18v4" />
      <path d="M8 22h8" />
      <path d="M3 3l18 18" />
    </svg>
  ) : (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 1a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3Z" />
      <path d="M19 11a7 7 0 0 1-14 0" />
      <path d="M12 18v4" />
      <path d="M8 22h8" />
    </svg>
  );
}

function IconCam({ off, className = "h-5 w-5" }) {
  return off ? (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M14.12 9.88 16 8h3a2 2 0 0 1 2 2v4" />
      <path d="M2 2l20 20" />
      <path d="M15 12v4a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" />
      <path d="M21 14l-5-3v2.5" />
    </svg>
  ) : (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M15 10l4.55-2.28A1 1 0 0 1 21 8.62v6.76a1 1 0 0 1-1.45.9L15 14" />
      <rect x="3" y="6" width="12" height="12" rx="2" />
    </svg>
  );
}

function IconScreen({ className = "h-5 w-5" }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M7 20h10" />
      <path d="M12 16v4" />
    </svg>
  );
}

function IconChat({ className = "h-5 w-5" }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4Z" />
    </svg>
  );
}

function IconHand({ className = "h-5 w-5" }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M7 11V5a1 1 0 0 1 2 0v6" />
      <path d="M11 11V4a1 1 0 0 1 2 0v7" />
      <path d="M15 11V6a1 1 0 0 1 2 0v5" />
      <path d="M19 11V8a1 1 0 0 1 2 0v7a6 6 0 0 1-6 6H11a6 6 0 0 1-6-6v-3a2 2 0 0 1 4 0v1" />
    </svg>
  );
}

function IconPhone({ className = "h-5 w-5" }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M22 16.92v3a2 2 0 0 1-2.18 2A19.86 19.86 0 0 1 3.09 5.18 2 2 0 0 1 5.11 3h3a2 2 0 0 1 2 1.72c.12.86.31 1.7.57 2.5a2 2 0 0 1-.45 2.11L9.09 10.91a16 16 0 0 0 4 4l1.58-1.14a2 2 0 0 1 2.11-.45c.8.26 1.64.45 2.5.57A2 2 0 0 1 22 16.92Z" />
    </svg>
  );
}

function TopBar({ roomName, participantCount, elapsedSeconds, onLeave }) {
  return (
    <div className="sticky top-0 z-30 w-full bg-[#202124]/90 backdrop-blur border-b border-white/10">
      <div className="flex items-center justify-between gap-3 px-3 sm:px-4 py-2.5">
        <div className="min-w-0">
          <div className="text-sm sm:text-base font-semibold truncate">
            {roomName ? `Room: ${roomName}` : "Live Class"}
          </div>
          <div className="text-xs text-white/60 truncate">
            {participantCount} participant{participantCount === 1 ? "" : "s"} • {formatDuration(elapsedSeconds)}
          </div>
        </div>

        <button
          type="button"
          onClick={onLeave}
          className="shrink-0 inline-flex items-center gap-2 px-3 py-2 rounded-full bg-rose-600 hover:bg-rose-500 active:bg-rose-700 transition-colors text-sm font-medium"
        >
          Leave
        </button>
      </div>
    </div>
  );
}

function ControlButton({ active, danger, onClick, title, children }) {
  const base =
    "h-12 w-12 rounded-full inline-flex items-center justify-center transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-white/20";
  const cls = danger
    ? "bg-rose-600 hover:bg-rose-500 active:bg-rose-700 text-white"
    : active
      ? "bg-white/15 hover:bg-white/20 active:bg-white/25 text-white"
      : "bg-white/10 hover:bg-white/15 active:bg-white/20 text-white";
  return (
    <button type="button" aria-pressed={!!active} onClick={onClick} title={title} className={`${base} ${cls}`}>
      {children}
    </button>
  );
}

function ControlsBar({
  micOn,
  camOn,
  isSharing,
  handRaised,
  onToggleMic,
  onToggleCam,
  onToggleShare,
  onOpenChat,
  onToggleHand,
  onLeave,
}) {
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-4 z-30">
      <div className="pointer-events-auto mx-auto w-fit max-w-[calc(100%-1.5rem)]">
        <div className="flex items-center gap-2 sm:gap-3 px-3 py-2 rounded-full bg-black/50 backdrop-blur border border-white/10 shadow-lg">
          <ControlButton
            active={micOn}
            danger={!micOn}
            onClick={onToggleMic}
            title={micOn ? "Mute microphone" : "Unmute microphone"}
          >
            <IconMic muted={!micOn} />
          </ControlButton>
          <ControlButton
            active={camOn}
            danger={!camOn}
            onClick={onToggleCam}
            title={camOn ? "Turn off camera" : "Turn on camera"}
          >
            <IconCam off={!camOn} />
          </ControlButton>
          <ControlButton active={isSharing} onClick={onToggleShare} title={isSharing ? "Stop sharing" : "Share screen"}>
            <IconScreen />
          </ControlButton>
          <ControlButton active={false} onClick={onOpenChat} title="Open chat">
            <IconChat />
          </ControlButton>
          <ControlButton active={handRaised} onClick={onToggleHand} title={handRaised ? "Lower hand" : "Raise hand"}>
            <IconHand />
          </ControlButton>
          <ControlButton danger onClick={onLeave} title="Leave call">
            <IconPhone />
          </ControlButton>
        </div>
      </div>
    </div>
  );
}

function VideoTile({ stream, name, muted, micOn, camOn, handRaised }) {
  const videoRef = useRef(null);
  const [forceMuted, setForceMuted] = useState(false);

  useEffect(() => {
    if (!videoRef.current) return;
    videoRef.current.srcObject = stream || null;

    const v = videoRef.current;
    if (!stream) return;

    const p = v.play?.();
    if (p && typeof p.catch === "function") {
      p.catch(() => {
        // Mobile browsers sometimes block autoplay when not muted.
        // Force-mute as a fallback so video can start.
        if (!muted) setForceMuted(true);
      });
    }
  }, [stream]);

  const showAvatar = !camOn;

  return (
    <div className="group relative overflow-hidden rounded-2xl bg-black/40 border border-white/10 shadow-sm">
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted={muted || forceMuted}
        className="h-full w-full object-cover bg-black"
      />

      {/* If camera is off, show a Meet-style avatar placeholder. */}
      {showAvatar ? (
        <div className="absolute inset-0 flex items-center justify-center bg-black/70">
          <div className="h-16 w-16 rounded-full bg-white/10 flex items-center justify-center text-lg font-semibold">
            {initialsFromName(name)}
          </div>
        </div>
      ) : null}

      <div className="pointer-events-none absolute inset-0 ring-1 ring-white/0 group-hover:ring-white/15 transition" />

      {/* Name overlay (bottom-left) */}
      <div className="absolute left-2.5 bottom-2.5">
        <div className="px-2.5 py-1 rounded-full bg-black/55 backdrop-blur text-xs text-white/90">{name}</div>
      </div>

      {/* Mic status icon (+ hand indicator) */}
      <div className="absolute right-2.5 bottom-2.5 flex items-center gap-2">
        {handRaised ? (
          <span className="px-2 py-1 rounded-full bg-amber-500/20 text-amber-200 text-xs border border-amber-400/20">
            Hand
          </span>
        ) : null}
        <div className="h-8 w-8 rounded-full bg-black/55 backdrop-blur border border-white/10 flex items-center justify-center">
          <IconMic muted={!micOn} className="h-4 w-4" />
        </div>
      </div>
    </div>
  );
}

export default function LiveView({ user }) {
  const pcRef = useRef(null);
  const roomRef = useRef(null);
  const inClassRef = useRef(false);
  const pendingIceRef = useRef([]);

  const localStreamRef = useRef(null);
  const cameraTrackRef = useRef(null);
  const screenTrackRef = useRef(null);

  const liveSessionIdRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const recordedChunksRef = useRef([]);

  const defaultRoom = typeof window !== "undefined" ? localStorage.getItem("liveRoom") : null;

  const [roomInput, setRoomInput] = useState(defaultRoom || "");
  const [joinedRoom, setJoinedRoom] = useState(!!defaultRoom);
  const [inClass, setInClass] = useState(false);

  // Side panel (Meet-style): opened via the controls bar.
  const [showTools, setShowTools] = useState(false);
  const [activeTool, setActiveTool] = useState("chat"); // chat | assignments

  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(true);
  const [handRaised, setHandRaised] = useState(false);
  const [isSharing, setIsSharing] = useState(false);

  const [localStream, setLocalStream] = useState(null);
  const [remoteStreams, setRemoteStreams] = useState([]); // structure ready for multiple participants

  const [callStartedAt, setCallStartedAt] = useState(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  const [chatText, setChatText] = useState("");
  const [chatMessages, setChatMessages] = useState([]);
  const chatEndRef = useRef(null);

  const [assignmentTitle, setAssignmentTitle] = useState("");
  const [assignmentFile, setAssignmentFile] = useState(null);
  const [assignmentUploading, setAssignmentUploading] = useState(false);
  const [assignmentsLoading, setAssignmentsLoading] = useState(false);
  const [assignments, setAssignments] = useState([]);
  const [expandedAssignmentId, setExpandedAssignmentId] = useState(null);

  const [recordingState, setRecordingState] = useState("idle"); // idle | recording | saving | error

  const roomId = useMemo(() => normalizeRoom(roomInput || defaultRoom || ""), [roomInput, defaultRoom]);
  const isTeacherLike = user?.role === "teacher" || user?.role === "staff" || user?.role === "admin";

  useEffect(() => {
    inClassRef.current = inClass;
  }, [inClass]);

  const participants = useMemo(() => {
    const local = {
      id: "local",
      name: user?.name ? `${user.name} (You)` : "You",
      stream: localStream,
      micOn,
      camOn,
      handRaised,
      muted: true,
    };

    const remotes = (remoteStreams || []).map((s, idx) => ({
      id: s?.id || `remote-${idx}`,
      name: `Participant ${idx + 1}`,
      stream: s,
      micOn: true,
      camOn: true,
      handRaised: false,
      muted: false,
    }));

    // Meet-style: show at least one extra tile while alone.
    const base = [local, ...remotes];
    if (base.length === 1) {
      base.push({
        id: "waiting",
        name: "Waiting for others…",
        stream: null,
        micOn: false,
        camOn: false,
        handRaised: false,
        muted: true,
      });
    }

    return base;
  }, [user?.name, localStream, micOn, camOn, handRaised, remoteStreams]);

  const ensureJoinedRoom = async (promptText) => {
    let id = roomId;
    if (!id) {
      const prompted = prompt(promptText, "english-demo");
      id = normalizeRoom(prompted);
      if (!id) return null;
      setRoomInput(id);
    }

    if (typeof window !== "undefined") localStorage.setItem("liveRoom", id);

    roomRef.current = id;
    socket.emit("join", id);
    setJoinedRoom(true);
    return id;
  };

  const openLiveRoomWindow = (id) => {
    if (!id || typeof window === "undefined") return;
    localStorage.setItem("liveRoom", id);
    const width = Math.min(Math.max(Math.floor(window.innerWidth * 0.9), 360), 1400);
    const height = Math.min(Math.max(Math.floor(window.innerHeight * 0.9), 640), 1000);
    window.open(`/live/${id}`, "_blank", `width=${width},height=${height}`);
  };

  const createPC = () => {
    // WebRTC peer connection skeleton.
    // Current signaling is room-level (offer/answer/ice). To scale to many participants later,
    // extend signaling with peer IDs and create one PC per remote peer.
    const pc = new RTCPeerConnection({
      iceServers: getIceServers(),
    });

    pc.onicecandidate = (e) => {
      if (!e.candidate) return;
      socket.emit("ice-candidate", { room: roomRef.current, candidate: e.candidate });
    };

    pc.onconnectionstatechange = () => {
      // Helpful when debugging why remote stays black (ICE often fails without TURN).
      // eslint-disable-next-line no-console
      console.log("PC connection state:", pc.connectionState);
    };

    pc.ontrack = (e) => {
      const stream = e.streams?.[0];
      if (!stream) return;
      setRemoteStreams((prev) => {
        const list = Array.isArray(prev) ? prev : [];
        if (list.some((s) => s?.id === stream.id)) return list;
        return [...list, stream];
      });
    };

    return pc;
  };

  const flushPendingIce = async () => {
    const pc = pcRef.current;
    if (!pc) return;
    if (!pc.remoteDescription) return;

    const pending = pendingIceRef.current;
    if (!pending.length) return;
    pendingIceRef.current = [];

    for (const candidate of pending) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await pc.addIceCandidate(candidate);
      } catch (e) {
        console.error("ICE flush error", e);
      }
    }
  };

  const ensureLocalMedia = async () => {
    // Uses getUserMedia (required). Local video renders via <VideoTile />.
    if (localStreamRef.current) return localStreamRef.current;
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    localStreamRef.current = stream;
    setLocalStream(stream);
    return stream;
  };

  const attachTracks = (pc, stream) => {
    const existingTracks = pc
      .getSenders()
      .map((s) => s.track)
      .filter(Boolean);
    stream.getTracks().forEach((t) => {
      if (!existingTracks.includes(t)) pc.addTrack(t, stream);
    });
  };

  const toggleMic = () => {
    if (!localStreamRef.current) return;
    const next = !micOn;
    localStreamRef.current.getAudioTracks().forEach((t) => {
      // eslint-disable-next-line no-param-reassign
      t.enabled = next;
    });
    setMicOn(next);
  };

  const toggleCam = () => {
    if (!localStreamRef.current) return;
    const next = !camOn;
    localStreamRef.current.getVideoTracks().forEach((t) => {
      // eslint-disable-next-line no-param-reassign
      t.enabled = next;
    });
    setCamOn(next);
  };

  const stopScreenShare = async () => {
    try {
      const screenTrack = screenTrackRef.current;
      if (screenTrack) screenTrack.stop();
    } catch {
      // ignore
    } finally {
      screenTrackRef.current = null;
    }

    const camTrack = cameraTrackRef.current;
    const pc = pcRef.current;
    const stream = localStreamRef.current;

    if (camTrack && pc) {
      const sender = pc.getSenders().find((s) => s.track && s.track.kind === "video");
      if (sender) await sender.replaceTrack(camTrack);
    }

    if (camTrack && stream) {
      const current = stream.getVideoTracks()[0];
      if (current && current !== camTrack) {
        try {
          stream.removeTrack(current);
        } catch {
          // ignore
        }
        stream.addTrack(camTrack);
      }
      setLocalStream(stream);
    }

    setIsSharing(false);
  };

  const toggleScreenShare = async () => {
    // Screen share (Meet-style): replace the outgoing video track on the existing RTCPeerConnection.
    // Keeps signaling/backends unchanged.
    if (isSharing) {
      await stopScreenShare();
      return;
    }

    const stream = await ensureLocalMedia();
    const pc = pcRef.current;
    if (!cameraTrackRef.current) cameraTrackRef.current = stream.getVideoTracks()[0] || null;

    const displayStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    const screenTrack = displayStream.getVideoTracks()[0];
    if (!screenTrack) return;
    screenTrackRef.current = screenTrack;

    screenTrack.onended = () => {
      stopScreenShare();
    };

    // Update local preview.
    try {
      const current = stream.getVideoTracks()[0];
      if (current && current !== screenTrack) stream.removeTrack(current);
      stream.addTrack(screenTrack);
      setLocalStream(stream);
    } catch {
      // ignore
    }

    // Replace outgoing track (if connected).
    if (pc) {
      const sender = pc.getSenders().find((s) => s.track && s.track.kind === "video");
      if (sender) await sender.replaceTrack(screenTrack);
    }

    setIsSharing(true);
  };

  const fetchAssignments = async (id) => {
    if (!id) return;
    setAssignmentsLoading(true);
    try {
      const res = await API.get(`/assignments?room=${encodeURIComponent(id)}`);
      const data = res.data;
      const list = Array.isArray(data?.assignments) ? data.assignments : [];
      setAssignments(
        list.map((a) => ({
          ...a,
          fileUrl: a?._id
            ? apiUrl(`/assignments/${a._id}/preview?name=${encodeURIComponent(a.filename || a.title || "assignment.pdf")}`)
            : a?.fileUrl,
          description: a?.description || (a?.filename ? `PDF: ${a.filename}` : ""),
        }))
      );
    } catch (e) {
      console.error("Assignments fetch error", e);
      setAssignments([]);
    } finally {
      setAssignmentsLoading(false);
    }
  };

  const pickBestRecorderMimeType = () => {
    const candidates = [
      "video/webm;codecs=vp9,opus",
      "video/webm;codecs=vp8,opus",
      "video/webm",
    ];
    if (typeof MediaRecorder === "undefined") return "";
    for (const t of candidates) {
      if (MediaRecorder.isTypeSupported(t)) return t;
    }
    return "";
  };

  const startTeacherSessionIfNeeded = async (id) => {
    if (!isTeacherLike) return null;
    if (liveSessionIdRef.current) return liveSessionIdRef.current;

    const token = localStorage.getItem("token");
    try {
      const res = await API.post(
        "/timetable/live-sessions/start",
        {
          roomId: id,
          className: id,
        },
        {
          headers: {
            Authorization: token ? `Bearer ${token}` : undefined,
          },
        }
      );
      const data = res.data;
      if (!data?.session) throw new Error(data?.error || "Failed to start session");
      const sessionId = data?.session?._id || null;
      liveSessionIdRef.current = sessionId;
      return sessionId;
    } catch (e) {
      console.error("Live session start failed", e);
      return null;
    }
  };

  const startRecording = async (id) => {
    if (!isTeacherLike) return;
    if (recordingState === "recording") return;
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") return;

    if (typeof MediaRecorder === "undefined") {
      setRecordingState("error");
      alert("Recording is not supported in this browser.");
      return;
    }

    const stream = await ensureLocalMedia();
    if (!stream) return;

    await startTeacherSessionIfNeeded(id);

    recordedChunksRef.current = [];
    const mimeType = pickBestRecorderMimeType();
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    mediaRecorderRef.current = recorder;

    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) recordedChunksRef.current.push(e.data);
    };

    recorder.onerror = (e) => {
      console.error("MediaRecorder error", e);
      setRecordingState("error");
    };

    recorder.onstart = () => setRecordingState("recording");
    recorder.onstop = () => {
      // state handled by stopRecordingAndUpload
    };

    try {
      recorder.start(1000);
    } catch (e) {
      console.error("Recorder start failed", e);
      setRecordingState("error");
    }
  };

  const stopRecordingAndUpload = async () => {
    if (!isTeacherLike) return;

    const recorder = mediaRecorderRef.current;
    const sessionId = liveSessionIdRef.current;
    if (!sessionId) return;

    // If recording never started, still mark the session ended.
    if (!recorder || recorder.state === "inactive") {
      const token = localStorage.getItem("token");
      const form = new FormData();
      form.append("sessionId", sessionId);
      try {
        await API.post("/timetable/live-sessions/end", form, {
          headers: {
            Authorization: token ? `Bearer ${token}` : undefined,
          },
        });
      } catch (e) {
        console.error("Session end (no recording) failed", e);
      }
      return;
    }

    setRecordingState("saving");

    const blob = await new Promise((resolve) => {
      const finalize = () => {
        try {
          const chunks = recordedChunksRef.current || [];
          resolve(new Blob(chunks, { type: recorder.mimeType || "video/webm" }));
        } catch {
          resolve(null);
        }
      };

      recorder.onstop = finalize;
      try {
        recorder.stop();
      } catch {
        finalize();
      }
    });

    mediaRecorderRef.current = null;
    recordedChunksRef.current = [];

    if (!blob || blob.size === 0) {
      const token = localStorage.getItem("token");
      const form = new FormData();
      form.append("sessionId", sessionId);
      try {
        await API.post("/timetable/live-sessions/end", form, {
          headers: {
            Authorization: token ? `Bearer ${token}` : undefined,
          },
        });
      } catch (e) {
        console.error("Session end (empty recording) failed", e);
      }
      setRecordingState("idle");
      return;
    }

    const token = localStorage.getItem("token");
    const form = new FormData();
    form.append("sessionId", sessionId);
    form.append("recording", blob, `recording_${sessionId}.webm`);

    try {
      const res = await API.post("/timetable/live-sessions/end", form, {
        headers: {
          Authorization: token ? `Bearer ${token}` : undefined,
        },
      });
      const data = res.data;
      if (!data?.session) throw new Error(data?.error || "Failed to upload recording");
    } catch (e) {
      console.error("Recording upload failed", e);
      setRecordingState("error");
      return;
    }

    setRecordingState("idle");
  };

  const sendChat = () => {
    const id = roomRef.current;
    const cleaned = chatText.trim();
    if (!id || !cleaned) return;
    socket.emit("chat-send", {
      room: id,
      text: cleaned,
      user: { id: user?.id, name: user?.name, role: user?.role },
    });
    setChatText("");
  };

  const uploadAssignment = async (e) => {
    e.preventDefault();
    const id = roomRef.current || roomId;
    if (!id) return alert("Set a room first");
    if (!assignmentFile) return alert("Please choose a PDF");

    const token = localStorage.getItem("token");
    const form = new FormData();
    form.append("room", id);
    form.append("title", assignmentTitle);
    form.append("file", assignmentFile);

    setAssignmentUploading(true);
    try {
      const res = await API.post("/assignments", form, {
        headers: {
          Authorization: token ? `Bearer ${token}` : undefined,
        },
      });
      const data = res.data;
      if (!data?.assignment) {
        alert(data?.error || "Upload failed");
        return;
      }
      setAssignmentTitle("");
      setAssignmentFile(null);
      await fetchAssignments(id);
      if (data?.assignment?._id) setExpandedAssignmentId(data.assignment._id);

      // Link assignment to the current live session (for timetable icons).
      try {
        const sessionId = liveSessionIdRef.current;
        const fileUrl = data?.assignment?._id
          ? apiUrl(`/assignments/${data.assignment._id}/preview?name=${encodeURIComponent(
              data.assignment.filename || data.assignment.title || "assignment.pdf"
            )}`)
          : "";
        await API.post(
          "/timetable/live-sessions/assignment",
          {
            sessionId,
            roomId: id,
            assignment: {
              title: data?.assignment?.title || assignmentTitle || "Assignment",
              description: "PDF assignment",
              fileUrl,
            },
          },
          {
            headers: {
              Authorization: token ? `Bearer ${token}` : undefined,
            },
          }
        );
      } catch (e) {
        console.error("Failed to link assignment to session", e);
      }
    } catch (err) {
      console.error("Assignment upload error", err);
      alert("Upload error");
    } finally {
      setAssignmentUploading(false);
    }
  };

  const leaveClass = async () => {
    if (isTeacherLike) {
      await stopRecordingAndUpload();
      liveSessionIdRef.current = null;
    }
    await stopScreenShare();

    try {
      if (pcRef.current) {
        pcRef.current.onicecandidate = null;
        pcRef.current.ontrack = null;
        pcRef.current.close();
      }
    } catch {
      // ignore
    } finally {
      pcRef.current = null;
    }

    try {
      if (localStreamRef.current) localStreamRef.current.getTracks().forEach((t) => t.stop());
    } catch {
      // ignore
    } finally {
      localStreamRef.current = null;
      setLocalStream(null);
    }

    setRemoteStreams([]);
    setMicOn(true);
    setCamOn(true);
    setHandRaised(false);
    setIsSharing(false);
    setShowTools(false);
    setActiveTool("chat");
    setInClass(false);
    setCallStartedAt(null);
    setElapsedSeconds(0);
  };

  const start = async () => {
    const id = await ensureJoinedRoom("Enter room name for your class:");
    if (!id) return;
    openLiveRoomWindow(id);
  };

  const join = async () => {
    const id = await ensureJoinedRoom("Enter room name to join:");
    if (!id) return;
    openLiveRoomWindow(id);
  };

  useEffect(() => {
    const maybeSendOffer = async () => {
      try {
        const room = roomRef.current;
        const pc = pcRef.current;
        if (!room || !pc) return;
        if (!inClassRef.current) return;

        // Only renegotiate when stable to avoid glare.
        if (pc.signalingState !== "stable") return;

        const stream = await ensureLocalMedia();
        attachTracks(pc, stream);

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit("offer", { room, offer });
      } catch (e) {
        console.error("Offer renegotiation error", e);
      }
    };

    const onOffer = async ({ offer }) => {
      try {
        if (!offer) return;
        const room = roomRef.current;
        if (!room) return;

        let pc = pcRef.current;
        if (!pc) {
          pc = createPC();
          pcRef.current = pc;
        }

        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        await flushPendingIce();
        const stream = await ensureLocalMedia();
        attachTracks(pc, stream);

        setInClass(true);
        setCallStartedAt((prev) => prev || Date.now());

        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit("answer", { room, answer });
      } catch (e) {
        console.error("Offer handling error", e);
      }
    };

    const onAnswer = async ({ answer }) => {
      try {
        if (!answer || !pcRef.current) return;
        await pcRef.current.setRemoteDescription(new RTCSessionDescription(answer));
        await flushPendingIce();
      } catch (e) {
        console.error("Answer handling error", e);
      }
    };

    const onIce = async ({ candidate }) => {
      try {
        if (!candidate) return;

        const pc = pcRef.current;
        // Candidates can arrive before the peer connection exists or before remoteDescription is set.
        // Buffer and flush once ready to avoid dropping ICE.
        if (!pc || !pc.remoteDescription) {
          pendingIceRef.current.push(candidate);
          return;
        }

        await pc.addIceCandidate(candidate);
      } catch (e) {
        console.error("ICE handling error", e);
      }
    };

    socket.on("offer", onOffer);
    socket.on("answer", onAnswer);
    socket.on("ice-candidate", onIce);

    // Important: if someone joins after an offer was sent, they will miss it.
    // When a new peer joins, re-send an offer from the side that already has a PC (typically the starter).
    socket.on("peer-joined", maybeSendOffer);

    socket.on("chat-history", ({ room, messages }) => {
      if (!room || room !== roomRef.current) return;
      setChatMessages(Array.isArray(messages) ? messages : []);
    });

    socket.on("chat-message", ({ room, message }) => {
      if (!room || room !== roomRef.current) return;
      if (!message) return;
      setChatMessages((prev) => [...prev, message]);
    });

    return () => {
      socket.off("offer", onOffer);
      socket.off("answer", onAnswer);
      socket.off("ice-candidate", onIce);
      socket.off("peer-joined", maybeSendOffer);
      socket.off("chat-history");
      socket.off("chat-message");
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (chatEndRef.current) chatEndRef.current.scrollIntoView({ behavior: "smooth" });
  }, [chatMessages.length]);

  useEffect(() => {
    if (!roomId) return;
    roomRef.current = roomId;
    socket.emit("join", roomId);
    setJoinedRoom(true);
    fetchAssignments(roomId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId]);

  // Call duration timer.
  useEffect(() => {
    if (!inClass || !callStartedAt) return undefined;
    const t = setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - callStartedAt) / 1000));
    }, 1000);
    return () => clearInterval(t);
  }, [inClass, callStartedAt]);

  const toolsPanel = (
    <div className="h-full w-full bg-[#1f2023] border-l border-white/10 flex flex-col min-w-0">
      <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-white/10 bg-black/20">
        <div className="min-w-0">
          <div className="font-semibold text-white">Tools</div>
          <div className="text-xs text-white/60 truncate">
            {roomRef.current ? `Room: ${roomRef.current}` : "Set a room to use tools"}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => setActiveTool("chat")}
            className={[
              "text-xs px-3 py-1.5 rounded-full border transition-colors",
              activeTool === "chat"
                ? "bg-white/15 border-white/15 text-white"
                : "bg-transparent border-white/10 text-white/80 hover:bg-white/10",
            ].join(" ")}
          >
            Chat
          </button>
          <button
            type="button"
            onClick={() => setActiveTool("assignments")}
            className={[
              "text-xs px-3 py-1.5 rounded-full border transition-colors",
              activeTool === "assignments"
                ? "bg-white/15 border-white/15 text-white"
                : "bg-transparent border-white/10 text-white/80 hover:bg-white/10",
            ].join(" ")}
          >
            Assignments
          </button>
          <button
            type="button"
            onClick={() => setShowTools(false)}
            className="h-9 w-9 rounded-full bg-white/10 hover:bg-white/15 active:bg-white/20 transition-colors inline-flex items-center justify-center"
            title="Close panel"
          >
            <span className="text-white/90 text-lg leading-none">×</span>
          </button>
        </div>
      </div>

      {activeTool === "chat" ? (
        <div className="flex flex-col min-h-0 flex-1">
          <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-2">
            {chatMessages.length === 0 ? (
              <div className="text-sm text-white/60">No messages yet</div>
            ) : (
              chatMessages.map((m) => (
                <div key={m.id} className="text-sm">
                  <div className="text-xs text-white/60 flex items-center gap-2">
                    <span className="font-medium text-white/85">{m?.user?.name || "User"}</span>
                    {m?.user?.role ? (
                      <span className="px-2 py-0.5 rounded-full bg-white/10 text-white/80 border border-white/10">
                        {m.user.role}
                      </span>
                    ) : null}
                  </div>
                  <div className="text-white/90 break-words">{m.text}</div>
                </div>
              ))
            )}
            <div ref={chatEndRef} />
          </div>

          <div className="p-3 border-t border-white/10 bg-black/10">
            <div className="flex gap-2 items-stretch min-w-0">
              <input
                value={chatText}
                onChange={(e) => setChatText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") sendChat();
                }}
                disabled={!roomRef.current}
                placeholder={roomRef.current ? "Type a message…" : "Set a room to start chatting"}
                className="min-w-0 flex-1 px-3 py-2 rounded-xl text-sm border border-white/10 bg-white/5 text-white placeholder:text-white/40 focus:outline-none focus:ring-2 focus:ring-white/10 disabled:opacity-60"
              />
              <button
                type="button"
                onClick={sendChat}
                disabled={!roomRef.current || !chatText.trim()}
                className="px-4 py-2 rounded-xl text-sm bg-white/15 hover:bg-white/20 active:bg-white/25 text-white disabled:opacity-60 shrink-0 transition-colors"
              >
                Send
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="p-3 space-y-3 overflow-y-auto">
          <div className="flex items-center justify-between gap-2">
            <div className="text-sm font-semibold text-white">Assignments</div>
            <button
              type="button"
              onClick={() => fetchAssignments(roomRef.current)}
              disabled={!roomRef.current || assignmentsLoading}
              className="text-xs px-3 py-1.5 rounded-full bg-white/10 hover:bg-white/15 active:bg-white/20 text-white/85 disabled:opacity-60 transition-colors"
            >
              Refresh
            </button>
          </div>

          {isTeacherLike ? (
            <form onSubmit={uploadAssignment} className="space-y-2">
              <input
                value={assignmentTitle}
                onChange={(e) => setAssignmentTitle(e.target.value)}
                placeholder="Assignment title (optional)"
                className="w-full px-3 py-2 rounded-xl text-sm border border-white/10 bg-white/5 text-white placeholder:text-white/40 focus:outline-none focus:ring-2 focus:ring-white/10"
              />
              <input
                type="file"
                accept="application/pdf"
                onChange={(e) => setAssignmentFile(e.target.files?.[0] || null)}
                className="w-full text-sm text-white/80 file:mr-3 file:px-3 file:py-1.5 file:rounded-lg file:border-0 file:bg-white/10 file:text-white file:hover:bg-white/15"
              />
              <button
                type="submit"
                disabled={!roomRef.current || assignmentUploading}
                className="w-full px-4 py-2 rounded-xl text-sm bg-white/15 hover:bg-white/20 active:bg-white/25 text-white disabled:opacity-60 transition-colors"
              >
                {assignmentUploading ? "Uploading..." : "Upload PDF"}
              </button>
            </form>
          ) : null}

          {assignmentsLoading ? (
            <div className="text-sm text-white/60">Loading…</div>
          ) : assignments.length === 0 ? (
            <div className="text-sm text-white/60">No assignments</div>
          ) : (
            <div className="space-y-2">
              {assignments.map((a) => (
                <div key={a._id} className="bg-white/5 border border-white/10 rounded-2xl overflow-hidden">
                  <button
                    type="button"
                    onClick={() => setExpandedAssignmentId((prev) => (prev === a._id ? null : a._id))}
                    className="w-full text-left px-3 py-2.5 flex items-center justify-between gap-3 hover:bg-white/5 transition-colors"
                  >
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-white truncate">{a.title || "Assignment"}</div>
                      <div className="text-xs text-white/60 truncate">
                        {a.createdAt ? new Date(a.createdAt).toLocaleString() : ""}
                      </div>
                    </div>
                    <div className="text-xs px-2 py-1 rounded-full bg-white/10 text-white/85 border border-white/10 shrink-0">
                      {expandedAssignmentId === a._id ? "Hide" : "View"}
                    </div>
                  </button>

                  {expandedAssignmentId === a._id ? (
                    <div className="px-3 pb-3">
                      <div className="text-sm text-white/80 mb-2">{a.description || "PDF assignment"}</div>
                      <a
                        href={a.fileUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-2 text-sm px-3 py-2 rounded-xl bg-white/15 hover:bg-white/20 active:bg-white/25 transition-colors text-white"
                      >
                        Open PDF
                      </a>
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );

  return (
    <div className="min-w-0">
      {/* Pre-call / room setup (kept minimal so it won’t affect other views/layout). */}
      {!inClass ? (
        <div className="bg-white/80 backdrop-blur-md rounded-2xl p-4 sm:p-6 shadow-soft">
          <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4 min-w-0">
            <div className="min-w-0">
              <h3 className="text-lg font-semibold text-slate-900">Live Class</h3>
              <p className="text-sm text-slate-500">Start or join a room</p>
            </div>

            <div className="flex flex-wrap gap-2 items-center justify-start lg:justify-end min-w-0">
              <div className="flex items-center gap-2 flex-wrap min-w-0">
                <input
                  value={roomInput}
                  onChange={(e) => setRoomInput(e.target.value)}
                  placeholder="Room (e.g., grade-8a)"
                  className="px-3 py-2 rounded-xl text-sm border border-slate-200 bg-white/60 w-full sm:w-56 max-w-full"
                />
                <button
                  type="button"
                  onClick={() => ensureJoinedRoom("Enter room name:")}
                  className="px-3 py-2 rounded-xl text-sm shrink-0 bg-primary/10 text-primary"
                >
                  {joinedRoom ? "Re-join" : "Set Room"}
                </button>
              </div>

              {isTeacherLike ? (
                <button type="button" onClick={start} className="px-4 py-2 rounded-xl text-sm shadow bg-primary text-white shrink-0">
                  Start Class
                </button>
              ) : (
                <button type="button" onClick={join} className="px-4 py-2 rounded-xl text-sm shrink-0 bg-primary/10 text-primary">
                  Join Class
                </button>
              )}
            </div>
          </div>
        </div>
      ) : null}

      {/* In-call (Google Meet-style) */}
      {inClass ? (
        <div className="relative mt-4 w-full overflow-hidden rounded-2xl border border-white/10 bg-[#202124] text-white">
          <TopBar
            roomName={roomRef.current || roomId}
            participantCount={1 + (remoteStreams?.length || 0)}
            elapsedSeconds={elapsedSeconds}
            onLeave={leaveClass}
          />

          <div className="relative flex min-h-[60vh]">
            {/* Video area */}
            <div className="flex-1 min-w-0 p-3 sm:p-4 pb-24">
              <div className="grid gap-3 sm:gap-4 grid-cols-[repeat(auto-fit,minmax(160px,1fr))] sm:grid-cols-[repeat(auto-fit,minmax(220px,1fr))] lg:grid-cols-[repeat(auto-fit,minmax(260px,1fr))] auto-rows-[minmax(180px,1fr)]">
                {participants.map((p) => (
                  <VideoTile
                    key={p.id}
                    stream={p.stream}
                    name={p.name}
                    muted={p.muted}
                    micOn={p.micOn}
                    camOn={p.camOn}
                    handRaised={p.handRaised}
                  />
                ))}
              </div>
            </div>

            {/* Desktop side panel */}
            <div
              className={[
                "hidden lg:block h-auto border-l border-white/10 bg-[#1f2023] transition-[width] duration-300 ease-out overflow-hidden",
                showTools ? "w-[380px]" : "w-0",
              ].join(" ")}
            >
              {showTools ? toolsPanel : null}
            </div>

            {/* Mobile side panel overlay */}
            {showTools ? (
              <div className="absolute inset-0 z-40 lg:hidden">
                <button
                  type="button"
                  aria-label="Close panel"
                  className="absolute inset-0 bg-black/60"
                  onClick={() => setShowTools(false)}
                />
                <div className="absolute inset-y-0 right-0 w-full max-w-[420px] shadow-2xl">{toolsPanel}</div>
              </div>
            ) : null}

            <ControlsBar
              micOn={micOn}
              camOn={camOn}
              isSharing={isSharing}
              handRaised={handRaised}
              onToggleMic={toggleMic}
              onToggleCam={toggleCam}
              onToggleShare={toggleScreenShare}
              onOpenChat={() => {
                setActiveTool("chat");
                setShowTools(true);
              }}
              onToggleHand={() => setHandRaised((v) => !v)}
              onLeave={leaveClass}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
