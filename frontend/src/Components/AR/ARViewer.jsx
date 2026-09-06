import React, { useEffect, useRef, useState } from "react";

export const AR_STATES = Object.freeze({ CHECKING_SUPPORT: "CHECKING_SUPPORT", REQUESTING_CAMERA: "REQUESTING_CAMERA", LOADING_ASSET: "LOADING_ASSET", AR_READY: "AR_READY", FALLBACK_3D: "FALLBACK_3D", ERROR: "ERROR" });

export default function ARViewer({ lesson, selected, onSelect }) {
  const host = useRef(null), viewer = useRef(null);
  const [state, setState] = useState(AR_STATES.CHECKING_SUPPORT);
  const [supported, setSupported] = useState(false);
  const [error, setError] = useState("");
  // Conservative default on constrained phones: reading mode first, with an
  // explicit optional 3D download. The AI computation never runs on the phone.
  const [load3D, setLoad3D] = useState(() => !(navigator.deviceMemory && navigator.deviceMemory <= 2) && !navigator.connection?.saveData);
  useEffect(() => {
    let active = true;
    let timeout;
    let element;
    const controller = new AbortController();
    const checkSupport = async () => {
      let xr = false;
      try { xr = !!(window.isSecureContext && navigator.xr && await navigator.xr.isSessionSupported("immersive-ar")); } catch { /* Normal unsupported capability. */ }
      if (active) setSupported(xr);
      return xr;
    };
    const setup = async () => {
      const xr = await checkSupport();
      if (!active || !load3D) { if (active) setState(AR_STATES.FALLBACK_3D); return; }
      setState(AR_STATES.LOADING_ASSET);
      timeout = setTimeout(() => { if (active) { setError("The 3D asset did not finish loading. The lesson and hotspots remain available below."); setState(AR_STATES.ERROR); } }, 20000);
      try {
        // Import only the selected experience, never on application startup.
        const { ModelViewerElement } = await import("@google/model-viewer");
        if (!active) return;
        ModelViewerElement.modelCacheSize = 0;
        ModelViewerElement.minimumRenderScale = 0.5;
        element = document.createElement("model-viewer");
        element.setAttribute("src", lesson.lowDetailModelUrl || lesson.modelUrl);
        element.setAttribute("alt", lesson.title);
        element.setAttribute("camera-controls", "");
        element.setAttribute("touch-action", "pan-y");
        element.setAttribute("ar", "");
        element.setAttribute("ar-modes", "webxr");
        element.setAttribute("loading", "lazy");
        element.setAttribute("interaction-prompt", "none");
        element.setAttribute("shadow-intensity", "0");
        element.setAttribute("camera-orbit", "0deg 75deg 0.6m");
        element.style.cssText = "width:100%;height:340px;background:#edf5fc;border-radius:16px;";
        // Hide model-viewer's default camera control: one explicit button below
        // owns permission requests, keeping camera access separate from the AI.
        const hiddenAR = document.createElement("span"); hiddenAR.slot = "ar-button"; hiddenAR.hidden = true; element.append(hiddenAR);
        for (const hotspot of lesson.hotspots || []) {
          const button = document.createElement("button");
          button.type = "button"; button.slot = `hotspot-${hotspot.id}`;
          button.setAttribute("data-position", hotspot.position.map((n) => `${n}m`).join(" "));
          button.setAttribute("data-normal", (hotspot.normal || [0, 0, 1]).join(" "));
          button.textContent = hotspot.label;
          button.style.cssText = "background:white;color:#0f766e;border:1px solid #0f766e;border-radius:8px;padding:6px;font:12px system-ui;";
          button.addEventListener("click", () => onSelect(hotspot.id), { signal: controller.signal });
          element.append(button);
        }
        element.addEventListener("load", () => { clearTimeout(timeout); if (active) { setError(""); setState(xr ? AR_STATES.AR_READY : AR_STATES.FALLBACK_3D); } }, { signal: controller.signal });
        element.addEventListener("error", () => { clearTimeout(timeout); if (active) { setError("This device could not render the 3D model. Use the illustrated lesson and part descriptions."); setState(AR_STATES.ERROR); } }, { signal: controller.signal });
        element.addEventListener("ar-status", (event) => {
          if (!active) return;
          if (event.detail.status === "session-started" || event.detail.status === "object-placed") setState(AR_STATES.AR_READY);
          if (event.detail.status === "not-presenting") setState(AR_STATES.FALLBACK_3D);
          if (event.detail.status === "failed") { setError("AR session could not start. Camera permission or WebXR support may be unavailable."); setState(AR_STATES.FALLBACK_3D); }
        }, { signal: controller.signal });
        host.current?.append(element); viewer.current = element;
      } catch (e) {
        clearTimeout(timeout);
        if (active) { setError("3D support could not be loaded. Reading mode is still available."); setState(AR_STATES.ERROR); }
      }
    };
    setup();
    return () => {
      active = false; clearTimeout(timeout); controller.abort();
      // model-viewer's disconnectedCallback unregisters its scene and ends AR.
      // With cache size 0 the loaded GPU asset is not retained after removal.
      element?.removeAttribute("src"); element?.remove(); viewer.current = null;
    };
  }, [lesson._id, load3D, onSelect]);

  const activate = async () => {
    setState(AR_STATES.REQUESTING_CAMERA); setError("");
    try { await viewer.current.activateAR(); }
    catch { setError("Camera permission or AR session was unavailable. Continue in 3D or reading mode."); setState(AR_STATES.FALLBACK_3D); }
  };
  return <section aria-label="AR and 3D viewer">
    <div role="status" className="mb-3 text-xs font-semibold tracking-wide text-slate-500">{state.replaceAll("_", " ")}</div>
    <div ref={host} data-testid="model-host" className={state === AR_STATES.ERROR ? "hidden" : ""} />
    {(!load3D || state === AR_STATES.ERROR) && lesson.fallbackImage && <img className="w-full rounded-2xl" src={lesson.fallbackImage} alt={`${lesson.topic}: illustrated teaching schematic`} loading="lazy" />}
    {error && <p role="alert" className="mt-3 text-sm text-amber-800 dark:text-amber-200">{error}</p>}
    <div className="mt-3 flex flex-wrap items-center gap-3">
      {!load3D && <button type="button" onClick={() => setLoad3D(true)} className="rounded-xl border border-teal-600 px-4 py-2 text-sm text-teal-700">Load optional 3D view ({Math.ceil(lesson.assetBytes / 1024)} KB)</button>}
      {load3D && <button type="button" onClick={() => setLoad3D(false)} className="text-sm underline">Use reading mode</button>}
      {supported && load3D && <button type="button" disabled={[AR_STATES.LOADING_ASSET, AR_STATES.REQUESTING_CAMERA, AR_STATES.ERROR].includes(state)} onClick={activate} className="rounded-xl bg-primary px-4 py-2 text-sm text-white disabled:opacity-50">Enable camera & enter AR</button>}
      {!supported && <p className="text-sm text-slate-500">Immersive AR is not supported here. You can still use 3D and read every hotspot.</p>}
    </div>
    <p className="mt-3 text-xs text-slate-500">Camera access is requested only when you enter AR. No frames are stored or uploaded to EduNova AI.</p>
  </section>;
}
