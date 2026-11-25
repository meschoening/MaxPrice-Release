// Where the session page's back chip goes (#640). The Sessions page it used
// to return to is gone, and the session page is reached from several places
// (Live's Top sessions, Projects), so Back means the browser's back:
// one step in history when the page was reached in-app. A session page that
// is the history's first entry (React Router's location key "default": a
// reload or a cold deep link) has nothing in-app behind it, so it goes to
// Projects, which lists each project's sessions.
export type SessionBackTarget = { kind: "history" } | { kind: "path"; path: string };

export const SESSION_BACK_FALLBACK = "/projects";

export function sessionBackTarget(locationKey: string): SessionBackTarget {
  return locationKey === "default"
    ? { kind: "path", path: SESSION_BACK_FALLBACK }
    : { kind: "history" };
}
