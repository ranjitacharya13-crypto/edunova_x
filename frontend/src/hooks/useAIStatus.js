import { useCallback, useEffect, useRef, useState } from "react";
import { AI_STATUS, aiStatusLabel, describeAICapabilities, getAIStatus } from "../api/api";

const READY_POLL_MS = 120_000;
const STARTING_POLL_MS = 5_000;
const OFFLINE_POLL_MS = 30_000;

const INITIAL_CAPABILITIES = Object.freeze({
  chat: false,
  timetable: false,
  subjects: false,
  quizAnalysis: false,
  studyPlanning: false,
  research: false,
});

/**
 * Live health and capability observer for EduNova AI.
 *
 * Distinguishes:
 * - READY ("healthy")
 * - DEGRADED
 * - STARTING / LOADING
 * - NOT_CONFIGURED
 * - UNAVAILABLE / RESOURCE_INSUFFICIENT
 * - INVALID_RESPONSE
 * - NETWORK_FAILURE
 */
export default function useAIStatus({ enabled = true } = {}) {
  const [state, setState] = useState({
    status: AI_STATUS.UNKNOWN,
    label: aiStatusLabel(AI_STATUS.UNKNOWN),
    detail: "",
    configured: null,
    provider: null,
    capabilities: { ...INITIAL_CAPABILITIES },
    code: null,
    terminal: false,
  });
  const timerRef = useRef(null);
  const mountedRef = useRef(true);

  const refresh = useCallback(async () => {
    const next = await getAIStatus();
    if (mountedRef.current) setState(next);
    return next;
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    if (!enabled) return undefined;

    let cancelled = false;
    const tick = async () => {
      const next = await refresh();
      if (cancelled || !mountedRef.current) return;
      if (next.terminal) return;
      let delay = READY_POLL_MS;
      if (next.status === AI_STATUS.STARTING || next.status === AI_STATUS.LOADING || next.status === AI_STATUS.BUSY) {
        delay = STARTING_POLL_MS;
      } else if (
        next.status === AI_STATUS.UNAVAILABLE ||
        next.status === AI_STATUS.NETWORK_FAILURE ||
        next.status === AI_STATUS.INVALID_RESPONSE
      ) {
        delay = OFFLINE_POLL_MS;
      }
      timerRef.current = window.setTimeout(tick, delay);
    };
    tick();

    return () => {
      cancelled = true;
      mountedRef.current = false;
      if (timerRef.current) window.clearTimeout(timerRef.current);
    };
  }, [enabled, refresh]);

  const isDegraded = state.status === AI_STATUS.DEGRADED;
  const isNotConfigured = state.status === AI_STATUS.NOT_CONFIGURED;
  const isInvalidResponse = state.status === AI_STATUS.INVALID_RESPONSE;
  const isNetworkFailure = state.status === AI_STATUS.NETWORK_FAILURE;
  const isResourceInsufficient = state.status === AI_STATUS.RESOURCE_INSUFFICIENT;
  const isUnavailable =
    state.status === AI_STATUS.UNAVAILABLE ||
    isResourceInsufficient ||
    isNotConfigured ||
    isInvalidResponse ||
    isNetworkFailure;

  return {
    ...state,
    isReady: state.status === AI_STATUS.READY,
    isDegraded,
    isStarting: state.status === AI_STATUS.STARTING || state.status === AI_STATUS.LOADING,
    isLoading: state.status === AI_STATUS.LOADING,
    isBusy: state.status === AI_STATUS.BUSY,
    isNotConfigured,
    isInvalidResponse,
    isNetworkFailure,
    isResourceInsufficient,
    isUnavailable,
    connectionSummary: describeAICapabilities(state),
    refresh,
  };
}
