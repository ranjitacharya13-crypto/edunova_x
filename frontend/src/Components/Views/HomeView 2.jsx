import React, { useEffect, useMemo, useState } from "react";
import {
  getTodayTimetable,
  getTodayTeacherTimetable,
} from "../../api/api";

function normalizeRoom(room) {
  return String(room || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function IconVideo({ className = "h-4 w-4" }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M10 8H6a2 2 0 0 0-2 2v4a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2v-4a2 2 0 0 0-2-2Z" />
      <path d="m14 10 6-3v10l-6-3Z" />
    </svg>
  );
}

function IconBookOpen({ className = "h-4 w-4" }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 7v14" />
      <path d="M3 18a2 2 0 0 0 2 2h7V6H5a2 2 0 0 0-2 2Z" />
      <path d="M21 18a2 2 0 0 1-2 2h-7V6h7a2 2 0 0 1 2 2Z" />
    </svg>
  );
}

function parseClockToDate(clockStr, baseDate = new Date()) {
  if (!clockStr) return null;
  const cleaned = String(clockStr).trim().toLowerCase();
  const match = cleaned.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!match) return null;

  const hourRaw = Number(match[1]);
  const minuteRaw = match[2] ? Number(match[2]) : 0;
  const meridiem = match[3] ? String(match[3]).toLowerCase() : null;

  if (!Number.isFinite(hourRaw) || !Number.isFinite(minuteRaw)) return null;
  if (hourRaw < 0 || hourRaw > 23 || minuteRaw < 0 || minuteRaw > 59) return null;

  let hour = hourRaw;
  if (meridiem === "am") {
    if (hour === 12) hour = 0;
  } else if (meridiem === "pm") {
    if (hour !== 12) hour += 12;
  } else {
    // legacy heuristic used in this project: treat 1–7 as afternoon (13–19)
    if (hour >= 1 && hour <= 7) hour += 12;
  }

  const d = new Date(baseDate);
  d.setHours(hour, minuteRaw, 0, 0);
  return d;
}

function parseTimeRange(timeStr, baseDate = new Date()) {
  if (!timeStr) return { start: null, end: null };
  const parts = String(timeStr)
    .split(/\s*(?:-|–|—|to)\s*/i)
    .map((s) => s.trim())
    .filter(Boolean);

  const start = parseClockToDate(parts[0], baseDate);
  const end = parseClockToDate(parts[1], baseDate);
  return { start, end };
}

function getPeriodStatus(timeStr, now = new Date()) {
  const { start, end } = parseTimeRange(timeStr, now);
  if (!start || !end) return "unknown";
  if (now.getTime() >= end.getTime()) return "finished";
  if (now.getTime() >= start.getTime() && now.getTime() < end.getTime()) return "live";
  return "upcoming";
}

export default function HomeView({ user, setView }) {
  const isTeacher = user?.role === "teacher";
  const isStudent = user?.role === "student";

  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 15000);
    return () => clearInterval(id);
  }, []);

  // =========================
  // STUDENT STATE
  // =========================
  const [studentPeriods, setStudentPeriods] = useState([]);
  const [studentLoading, setStudentLoading] = useState(true);

  // =========================
  // TEACHER STATE
  // =========================
  const [teacherPeriods, setTeacherPeriods] = useState([]);
  const [teacherLoading, setTeacherLoading] = useState(true);

  const [sessionsByRoom, setSessionsByRoom] = useState({});
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [recordingModal, setRecordingModal] = useState(null); // { title, url, time }
  const [assignmentModal, setAssignmentModal] = useState(null); // { title, description, fileUrl }

  // upcoming class (derived)
  const [upcoming, setUpcoming] = useState(null);

  // =========================
  // FETCH STUDENT TT
  // =========================
  useEffect(() => {
    if (isStudent) {
      getTodayTimetable().then((res) => {
        setStudentPeriods(res?.timetable || []);
        setStudentLoading(false);
      });
    }
  }, [isStudent]);

  // =========================
  // FETCH TEACHER TT
  // =========================
  useEffect(() => {
    if (isTeacher) {
      getTodayTeacherTimetable().then((res) => {
        setTeacherPeriods(res?.timetable || []);
        setTeacherLoading(false);
      });
    }
  }, [isTeacher]);

  // derive upcoming class from timetable
  useEffect(() => {
    const periods = isStudent ? studentPeriods : teacherPeriods;
    if (!periods || periods.length === 0) {
      setUpcoming(null);
      return;
    }

    const live = periods.find((p) => getPeriodStatus(p.time || "", now) === "live");
    if (live) {
      setUpcoming(live);
      return;
    }

    const next = periods.find((p) => {
      const { start } = parseTimeRange(p.time || "", now);
      return start && start.getTime() > now.getTime();
    });

    setUpcoming(next || periods[0]);
  }, [studentPeriods, teacherPeriods, isStudent, isTeacher, now]);

  useEffect(() => {
    const periods = isStudent ? studentPeriods : teacherPeriods;
    if (!periods || periods.length === 0) {
      setSessionsByRoom({});
      return undefined;
    }

    let cancelled = false;

    const fetchSessions = async () => {
      const rooms = periods
        .map((p) => normalizeRoom(p.subject || p.class))
        .filter(Boolean);

      setSessionsLoading(true);
      try {
        const res = await fetch(`/api/timetable/live-sessions/today?rooms=${encodeURIComponent(rooms.join(","))}`);
        const data = await res.json();
        if (cancelled) return;
        setSessionsByRoom(data?.byRoom || {});
      } catch (e) {
        if (cancelled) return;
        setSessionsByRoom({});
      } finally {
        if (!cancelled) setSessionsLoading(false);
      }
    };

    fetchSessions();
    const id = setInterval(fetchSessions, 30000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [studentPeriods, teacherPeriods, isStudent, isTeacher]);

  const upcomingStartText = useMemo(() => {
    if (!upcoming?.time) return "";
    const startClock = String(upcoming.time || "").split("-")[0]?.trim();
    const { start } = parseTimeRange(upcoming.time, now);
    if (!start) return startClock || "";
    const mins = Math.max(0, Math.round((start.getTime() - now.getTime()) / 60000));
    return mins > 0 ? `Starts in ${mins} minutes` : `Starts at ${startClock}`;
  }, [upcoming, now]);

  return (
    <>
      {/* HEADER */}
      <div className="mb-6">
        <h3 className="text-xl font-semibold">
          Welcome, {user?.name?.split(" ")[0]}!
        </h3>
        <p className="text-sm text-slate-500">
          Here's a quick snapshot of your classes and progress.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">

        {/* ========================= */}
        {/* UPCOMING CLASS */}
        {/* ========================= */}
        <div className="bg-white/80 backdrop-blur-md rounded-2xl p-5 shadow-soft">
          <div className="text-sm font-medium text-slate-500 mb-3">
            Upcoming Class
          </div>

          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-xl bg-primary/10
              grid place-items-center text-primary font-semibold">
              {upcoming ? (upcoming.subject || upcoming.class || "CL")
                .toString()
                .slice(0, 2)
                .toUpperCase() : "CL"}
            </div>

            <div className="flex-1">
              <div className="font-semibold text-slate-900">
                {upcoming ? (upcoming.subject || upcoming.class) : "No upcoming class"}
              </div>
              <div className="text-xs text-slate-400 mt-1">
                {upcomingStartText}
              </div>

              <div className="mt-3 flex gap-2">
                <button
                  onClick={() => {
                    if (!upcoming) return;
                    const room = (upcoming.subject || upcoming.class || "class")
                      .toString()
                      .toLowerCase()
                      .replace(/[^a-z0-9]+/g, "-")
                      .replace(/^-+|-+$/g, "");
                    localStorage.setItem("liveRoom", room);
                    setView?.("live");
                  }}
                  className="text-xs px-4 py-1.5 rounded-xl
                    bg-primary text-white shadow">
                  Join Class
                </button>
                <button
                  onClick={() => setView?.("study")}
                  className="text-xs px-4 py-1.5 rounded-xl
                    bg-primary/10 text-primary">
                  View Details
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* ========================= */}
        {/* RIGHT COLUMN */}
        {/* ========================= */}
        <div className="lg:col-span-2 space-y-6">

          {/* ========================= */}
          {/* STUDENT TIMETABLE */}
          {/* ========================= */}
          {isStudent && (
            <div className="bg-white/80 backdrop-blur-md rounded-2xl p-6 shadow-soft">
              <div className="flex items-center justify-between mb-4">
                <h4 className="font-semibold text-slate-900">
                  Today's Time Table
                </h4>
                <span className="text-xs px-3 py-1 rounded-full
                  bg-primary/10 text-primary">
                  Today
                </span>
              </div>

              {studentLoading ? (
                <p className="text-sm text-slate-500">Loading timetable...</p>
              ) : studentPeriods.length === 0 ? (
                <p className="text-sm text-slate-500">No timetable for today</p>
              ) : (
                <div className="overflow-x-auto rounded-xl border border-slate-100">
                  <table className="min-w-[560px] w-full text-sm">
                    <thead className="bg-primary/5 text-slate-600">
                      <tr>
                        <th className="text-left px-4 py-3 font-medium">
                          Period
                        </th>
                        <th className="text-left px-4 py-3 font-medium">
                          Time
                        </th>
                        <th className="text-left px-4 py-3 font-medium">
                          Subject
                        </th>
                        <th className="text-left px-4 py-3 font-medium">
                          Actions
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {studentPeriods.map((p, i) => {
                        const status = getPeriodStatus(p.time || "", now);
                        const subjectLabel = p.subject || "";
                        const room = normalizeRoom(subjectLabel);
                        const session = room ? sessionsByRoom?.[room] : null;
                        const sessionEnded = !!session?.endTime;
                        const isFinished = status === "finished" || sessionEnded;
                        const isLive = status === "live" && !sessionEnded;
                        const hasRecording = !!session?.recordingUrl;
                        const hasAssignment = !!(session?.assignment?.fileUrl || session?.assignment?.title);
                        const baseBg = i % 2 === 0 ? "bg-white" : "bg-slate-50/50";
                        const statusBg = isLive
                          ? "bg-emerald-500/10 backdrop-blur-md"
                          : isFinished
                            ? "bg-rose-500/10 backdrop-blur-md"
                            : baseBg;

                        const leftBar = isLive
                          ? "border-l-4 border-emerald-500"
                          : isFinished
                            ? "border-l-4 border-rose-500"
                            : "border-l-4 border-transparent";

                        return (
                          <tr
                            key={p.period ?? i}
                            className={`border-t transition-colors
                              ${statusBg}
                              ${isFinished ? "text-slate-500" : ""}
                              ${isLive ? "hover:bg-emerald-500/15" : "hover:bg-primary/5"}`}
                          >
                            <td className={`px-4 py-3 font-medium text-slate-700 ${leftBar}`}>
                              {p.period}
                            </td>
                            <td className="px-4 py-3 text-slate-600">
                              {p.time || "-"}
                            </td>
                            <td className="px-4 py-3 text-slate-600">
                              {p.subject}
                            </td>
                            <td className="px-4 py-3">
                              {isFinished ? (
                                <div className="flex items-center gap-2">
                                  {hasRecording ? (
                                    <button
                                      type="button"
                                      onClick={() =>
                                        setRecordingModal({
                                          title: subjectLabel || "Recording",
                                          url: session.recordingUrl,
                                          time: p.time || "",
                                        })
                                      }
                                      className="p-2 rounded-xl bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
                                      title="View Recording"
                                    >
                                      <IconVideo />
                                    </button>
                                  ) : null}
                                  {hasAssignment ? (
                                    <button
                                      type="button"
                                      onClick={() => setAssignmentModal(session.assignment)}
                                      className="p-2 rounded-xl bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
                                      title="View Assignment"
                                    >
                                      <IconBookOpen />
                                    </button>
                                  ) : null}
                                  {!hasRecording && !hasAssignment ? (
                                    <span className="text-xs text-slate-400">—</span>
                                  ) : null}
                                </div>
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => {
                                    if (!subjectLabel) return;
                                    const roomId = normalizeRoom(subjectLabel);
                                    localStorage.setItem("liveRoom", roomId);
                                    setView?.("live");
                                  }}
                                  className="text-xs px-4 py-1.5 rounded-xl bg-primary text-white shadow"
                                >
                                  Join Class
                                </button>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  {sessionsLoading ? (
                    <div className="px-4 py-2 text-xs text-slate-400 border-t">Updating…</div>
                  ) : null}
                </div>
              )}
            </div>
          )}

          {/* ========================= */}
          {/* TEACHER TIMETABLE */}
          {/* ========================= */}
          {isTeacher && (
            <div className="bg-white/80 backdrop-blur-md rounded-2xl p-6 shadow-soft">
              <h4 className="font-semibold mb-4 text-slate-900">
                Today's Schedule
              </h4>

              {teacherLoading ? (
                <p className="text-sm text-slate-500">Loading timetable...</p>
              ) : teacherPeriods.length === 0 ? (
                <p className="text-sm text-slate-500">No timetable for today</p>
              ) : (
                <div className="overflow-x-auto rounded-xl border border-slate-100">
                  <table className="min-w-[560px] w-full text-sm">
                    <thead className="bg-primary/5 text-slate-600">
                      <tr>
                        <th className="text-left px-4 py-3">Period</th>
                        <th className="text-left px-4 py-3">Time</th>
                        <th className="text-left px-4 py-3">Class</th>
                        <th className="text-left px-4 py-3">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {teacherPeriods.map((p, i) => {
                        const isLunch = p.class === "Lunch Break";
                        const status = isLunch ? "unknown" : getPeriodStatus(p.time || "", now);
                        const classLabel = p.class || "";
                        const room = isLunch ? "" : normalizeRoom(classLabel);
                        const session = room ? sessionsByRoom?.[room] : null;
                        const sessionEnded = !!session?.endTime;
                        const isFinished = status === "finished" || sessionEnded;
                        const isLive = status === "live" && !sessionEnded;
                        const hasRecording = !!session?.recordingUrl;
                        const hasAssignment = !!(session?.assignment?.fileUrl || session?.assignment?.title);
                        const statusBg = isLunch
                          ? "bg-accent/20 font-medium"
                          : isLive
                            ? "bg-emerald-500/10 backdrop-blur-md"
                            : isFinished
                              ? "bg-rose-500/10 backdrop-blur-md"
                              : "";

                        const leftBar = isLunch
                          ? "border-l-4 border-transparent"
                          : isLive
                            ? "border-l-4 border-emerald-500"
                            : isFinished
                              ? "border-l-4 border-rose-500"
                              : "border-l-4 border-transparent";

                        return (
                          <tr
                            key={p.period ?? i}
                            className={`border-t transition-colors
                              ${statusBg}
                              ${isFinished ? "text-slate-500" : ""}
                              ${isLunch ? "" : isLive ? "hover:bg-emerald-500/15" : "hover:bg-primary/5"}`}
                          >
                            <td className={`px-4 py-3 ${leftBar}`}>{p.period}</td>
                            <td className="px-4 py-3">{p.time}</td>
                            <td className="px-4 py-3">{p.class}</td>
                            <td className="px-4 py-3">
                              {isLunch ? (
                                <span className="text-xs text-slate-400">—</span>
                              ) : isFinished ? (
                                <div className="flex items-center gap-2">
                                  {hasRecording ? (
                                    <button
                                      type="button"
                                      onClick={() =>
                                        setRecordingModal({
                                          title: classLabel || "Recording",
                                          url: session.recordingUrl,
                                          time: p.time || "",
                                        })
                                      }
                                      className="p-2 rounded-xl bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
                                      title="View Recording"
                                    >
                                      <IconVideo />
                                    </button>
                                  ) : null}
                                  {hasAssignment ? (
                                    <button
                                      type="button"
                                      onClick={() => setAssignmentModal(session.assignment)}
                                      className="p-2 rounded-xl bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
                                      title="View Assignment"
                                    >
                                      <IconBookOpen />
                                    </button>
                                  ) : null}
                                  {!hasRecording && !hasAssignment ? (
                                    <span className="text-xs text-slate-400">—</span>
                                  ) : null}
                                </div>
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => {
                                    if (!classLabel) return;
                                    const roomId = normalizeRoom(classLabel);
                                    localStorage.setItem("liveRoom", roomId);
                                    setView?.("live");
                                  }}
                                  className="text-xs px-4 py-1.5 rounded-xl bg-primary text-white shadow"
                                >
                                  Join Class
                                </button>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  {sessionsLoading ? (
                    <div className="px-4 py-2 text-xs text-slate-400 border-t">Updating…</div>
                  ) : null}
                </div>
              )}
            </div>
          )}

        </div>
      </div>

      {/* RECORDING MODAL */}
      {recordingModal ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <button
            type="button"
            className="absolute inset-0 bg-black/70"
            aria-label="Close"
            onClick={() => setRecordingModal(null)}
          />
          <div className="relative w-full max-w-4xl rounded-2xl border border-white/10 bg-[#202124] text-white shadow-soft overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 border-b border-white/10 bg-black/20">
              <div className="min-w-0">
                <div className="font-semibold truncate">{recordingModal.title}</div>
                <div className="text-xs text-white/60 truncate">{recordingModal.time || "Recording"}</div>
              </div>
              <button
                type="button"
                onClick={() => setRecordingModal(null)}
                className="px-3 py-1.5 rounded-xl bg-white/10 hover:bg-white/15 text-sm"
              >
                Close
              </button>
            </div>
            <div className="p-4">
              <video
                src={recordingModal.url}
                controls
                playsInline
                className="w-full max-h-[70vh] rounded-xl bg-black"
              />
            </div>
          </div>
        </div>
      ) : null}

      {/* ASSIGNMENT MODAL */}
      {assignmentModal ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <button
            type="button"
            className="absolute inset-0 bg-black/70"
            aria-label="Close"
            onClick={() => setAssignmentModal(null)}
          />
          <div className="relative w-full max-w-xl rounded-2xl border border-white/10 bg-[#202124] text-white shadow-soft overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 border-b border-white/10 bg-black/20">
              <div className="font-semibold truncate">{assignmentModal.title || "Assignment"}</div>
              <button
                type="button"
                onClick={() => setAssignmentModal(null)}
                className="px-3 py-1.5 rounded-xl bg-white/10 hover:bg-white/15 text-sm"
              >
                Close
              </button>
            </div>
            <div className="p-4 space-y-3">
              <div className="text-sm text-white/70">{assignmentModal.description || "Assignment details"}</div>
              {assignmentModal.fileUrl ? (
                <a
                  href={assignmentModal.fileUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-2 text-sm px-3 py-2 rounded-xl bg-white/10 hover:bg-white/15 transition-colors"
                >
                  <IconBookOpen className="h-4 w-4" />
                  Open PDF
                </a>
              ) : (
                <div className="text-xs text-white/60">No file available</div>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
