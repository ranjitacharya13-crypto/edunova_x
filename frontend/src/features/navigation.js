// AI actions choose from views, never arbitrary URLs, scripts or browser APIs.
const VIEWS = new Set(["home", "timetable", "syllabus", "study", "live", "quiz", "progress", "study-plans", "ar", "assignments"]);
export function validDestination(value) {
  return !!value && VIEWS.has(value.view) && (!value.id || /^[a-zA-Z0-9-]{1,100}$/.test(value.id));
}
export function navigateTo(value) {
  if (!validDestination(value)) return false;
  window.dispatchEvent(new CustomEvent("edunova:navigate", { detail: value }));
  return true;
}
