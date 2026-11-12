// Devices something went wrong with while the app runs (a Syslog alert, a
// continuous ping gone unanswered), by host: marked in the session tree until
// one of their sessions is connected or one of their tabs is in front. Kept
// in memory only: a new run starts with none.

/** Lower-case host → what happened (an app phrase, translated where shown) and when it first did. */
const alerts = new Map<string, { note: string; at: number }>();
const listeners = new Set<() => void>();

const keyOf = (host: string) => host.trim().toLowerCase();

/** The note with its time, as shown: "… · 14:05" (each " · " part is translated on its own). */
const shown = (a: { note: string; at: number }) => `${a.note} · ${new Date(a.at).toTimeString().slice(0, 5)}`;

/** Something went wrong with the device at `host`; told to the listeners only
 * when that changes (the same note again keeps its first time: a device
 * sending one alert a second does not redraw the tree a second). */
export function markDeviceAlert(host: string, note: string) {
  const key = keyOf(host);
  if (!key || alerts.get(key)?.note === note) return;
  alerts.set(key, { note, at: Date.now() });
  listeners.forEach((f) => f());
}

/** The device at `host` was looked at (connected, its tab in front). */
export function clearDeviceAlert(host: string) {
  if (alerts.delete(keyOf(host))) listeners.forEach((f) => f());
}

/** What went wrong with the device at `host` and since when, if anything. */
export function deviceAlert(host: string): string | undefined {
  const a = alerts.get(keyOf(host));
  return a && shown(a);
}

/** When the device at `host` was marked (0 when it is not): for newest-first lists. */
export function deviceAlertAt(host: string): number {
  return alerts.get(keyOf(host))?.at ?? 0;
}

/** Every marked device: [lower-case host, what happened and since when], the newest first. */
export function deviceAlertList(): [string, string][] {
  return [...alerts].sort((a, b) => b[1].at - a[1].at).map(([host, a]) => [host, shown(a)]);
}

/** All marks put away at once (the status bar's list). */
export function clearAllDeviceAlerts() {
  if (!alerts.size) return;
  alerts.clear();
  listeners.forEach((f) => f());
}

export function onDeviceAlerts(f: () => void) {
  listeners.add(f);
}
