import React from "react";
import { navigateTo, validDestination } from "../features/navigation";

export default function AIAction({ action, onConfirm }) {
  const data = action.data || {};
  if (data.requiresConfirmation) return (
    <div className="space-y-2">
      <p>{action.message || action.tool}</p>
      {data.preview && <details><summary className="cursor-pointer">Review proposed changes</summary><pre className="max-h-52 overflow-auto whitespace-pre-wrap text-xs">{JSON.stringify(data.preview, null, 2)}</pre></details>}
      <button type="button" onClick={() => onConfirm(data.confirmationToken)} className="rounded-lg bg-primary px-3 py-2 text-white">Confirm and save</button>
    </div>
  );
  if (validDestination(data.navigate)) return <button type="button" onClick={() => navigateTo(data.navigate)} className="font-semibold underline">{action.message || "Open in EduNova"} →</button>;
  return <span>{action.message || action.tool}</span>;
}
