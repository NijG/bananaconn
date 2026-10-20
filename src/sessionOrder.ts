// How the session tree is ordered. Automatic orders (name, address, recently
// used) are computed; the manual order is the order of the stored session list
// itself (state.sessions, saved as is) and, for folders, Settings.folderOrder.

import type { Session } from "./model";

export type SessionSort = "name" | "address" | "recent" | "manual";

/** Natural order, case-insensitive: "AP2" before "AP10". */
export const natural = new Intl.Collator("ko", { numeric: true, sensitivity: "base" });

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** Rank (IPv4, IPv6, name, none) and value of a host for sorting by address. */
function addressKey(host: string): { rank: number; ip?: number[]; text: string } {
  const h = host.trim().replace(/^\[|\]$/g, "");
  const m = IPV4.exec(h);
  if (m && m.slice(1).every((p) => Number(p) <= 255)) return { rank: 0, ip: m.slice(1).map(Number), text: h };
  if (h.includes(":") && /^[0-9a-f:.]+$/i.test(h)) return { rank: 1, ip: ipv6Groups(h), text: h };
  return { rank: h ? 2 : 3, text: h };
}

/** The eight 16-bit groups of an IPv6 address ("::" expanded). */
function ipv6Groups(h: string): number[] {
  const [head, tail = ""] = h.split("::");
  const part = (s: string) => (s ? s.split(":").map((g) => (g.includes(".") ? 0 : parseInt(g, 16) || 0)) : []);
  const a = part(head);
  const b = part(tail);
  return [...a, ...Array(Math.max(0, 8 - a.length - b.length)).fill(0), ...b];
}

/** By address: IPv4 numerically (192.0.2.9 before 192.0.2.54), then
 * IPv6, then host names (COM ports among them) naturally; then port, name. */
export function compareAddress(a: Session, b: Session): number {
  const ka = addressKey(a.host);
  const kb = addressKey(b.host);
  if (ka.rank !== kb.rank) return ka.rank - kb.rank;
  if (ka.ip && kb.ip) {
    for (let i = 0; i < ka.ip.length; i++) if (ka.ip[i] !== kb.ip[i]) return ka.ip[i] - kb.ip[i];
  } else {
    const c = natural.compare(ka.text, kb.text);
    if (c) return c;
  }
  return (a.port ?? 0) - (b.port ?? 0) || natural.compare(a.name, b.name);
}

/** Sessions of one folder in the given order. `position`: each session's
 * index in the stored list (the manual order). */
export function sessionCompare(mode: SessionSort, position: Map<string, number>): (a: Session, b: Session) => number {
  switch (mode) {
    case "address":
      return compareAddress;
    case "recent":
      return (a, b) => (b.lastUsed ?? 0) - (a.lastUsed ?? 0) || natural.compare(a.name, b.name);
    case "manual":
      return (a, b) => (position.get(a.id) ?? 0) - (position.get(b.id) ?? 0);
    default:
      return (a, b) => natural.compare(a.name, b.name) || compareAddress(a, b);
  }
}

/** Sibling folders: by name, or in the saved manual order (folders not in it
 * yet, such as new ones, come after, by name). */
export function folderCompare(mode: SessionSort, folderOrder: string[]): (a: string, b: string) => number {
  const byName = (a: string, b: string) => natural.compare(a.split("/").pop()!, b.split("/").pop()!);
  if (mode !== "manual") return byName;
  const at = new Map(folderOrder.map((p, i) => [p, i]));
  return (a, b) => (at.get(a) ?? Infinity) - (at.get(b) ?? Infinity) || byName(a, b);
}
