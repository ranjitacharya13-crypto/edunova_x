import { useCallback, useEffect, useRef, useState } from "react";
import { AI_STATUS, aiStatusLabel, getAIStatus } from "../api/api";

const READY_POLL_MS = 120_000; // model is up: just keep an eye on it
const STARTING_POLL_MS = 5_000; // model is downloading/loading: track progress

/**
 * Live readiness of the self-hosted EduNova AI model.
 *
 * The AI service binds its port immediately and downloads/loads the local GGUF
 * weights in the background, so "the backend responded" does not mean "the AI
 * can answer". This hook reads the real llama.cpp lifecycle state through the
 * authenticated backend health endpoint so the UI can show
 * "AI model starting..." and only switch to "Ready to help" once inference is
 * genuinely available.
 */
export default function useAIStatus({ enabled = true } = {}) {
  const [state, setState] = useState({
    status: AI_STATUS.UNKNOWN,
    label: aiStatusLabel(AI_STATUS.UNKNOWN),
    detail: "",
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
      if (next.terminal) return; // A terminal failure needs operator intervention, not endless preparing polls.
      const delay = [AI_STATUS.READY, AI_STATUS.UNAVAILABLE, AI_STATUS.RESOURCE_INSUFFICIENT, AI_STATUS.UNKNOWN].includes(next.status) ? READY_POLL_MS : STARTING_POLL_MS;
      timerRef.current = window.setTimeout(tick, delay);
    };
    tick();

    return () => {
      cancelled = true;
      mountedRef.current = false;
      if (timerRef.current) window.clearTimeout(timerRef.current);
    };
  }, [enabled, refresh]);

  return {
    ...state,
    isReady: state.status === AI_STATUS.READY,
    // STARTING and LOADING are both "coming up" as far as the UI is concerned;
    // they are distinct states so the label can be honest about which one.
    isStarting:
      state.status === AI_STATUS.STARTING || state.status === AI_STATUS.LOADING,
    isLoading: state.status === AI_STATUS.LOADING,
    isBusy: state.status === AI_STATUS.BUSY,
    isResourceInsufficient: state.status === AI_STATUS.RESOURCE_INSUFFICIENT,
    isUnavailable: state.status === AI_STATUS.UNAVAILABLE || state.status === AI_STATUS.RESOURCE_INSUFFICIENT,
    refresh,
  };
}
