// en-US formatting, without leaning on Intl's compact notation (which renders
// "1.2M" with locale quirks). Here we want the lean "1.2M" / "12.3k" shape.

function compact(n: number, suffix: string, div: number): string {
  const v = n / div;
  // 1 decimal, but drop a trailing ".0" (e.g. 2.0M -> 2M)
  const s = v.toFixed(1).replace(/\.0$/, "");
  return s + suffix;
}

// tokens/residents/buildings -> "1.2M", "12.3k", "980"
export function formatCount(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0";
  if (n >= 1e9) return compact(n, "B", 1e9);
  if (n >= 1e6) return compact(n, "M", 1e6);
  if (n >= 1e3) return compact(n, "k", 1e3);
  return Math.round(n).toLocaleString("en-US");
}

// dollar cost -> "$1,059" (whole dollars, grouped), "$0.42" under a dollar, and
// compact ("$1.2M") above 100k.
export function formatCost(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "$0";
  if (n >= 1e9) return "$" + compact(n, "B", 1e9);
  if (n >= 1e6) return "$" + compact(n, "M", 1e6);
  if (n >= 1e5) return "$" + compact(n, "k", 1e3);
  if (n > 0 && n < 1) return "$" + n.toFixed(2);
  return "$" + Math.round(n).toLocaleString("en-US");
}

// ANNUALIZED cost (the 💸 headline) -> "$127k", "$48k", "$1.2M", "$1.2B".
// Rounds "smartly": whole thousands; millions/billions with 1 decimal. en-US.
function oneDec(v: number): string {
  return v.toFixed(1).replace(/\.0$/, "");
}
export function formatAnnualCost(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "$0";
  if (n >= 1e9) return "$" + oneDec(n / 1e9) + "B";
  if (n >= 1e6) return "$" + oneDec(n / 1e6) + "M";
  if (n >= 1e3) return "$" + Math.round(n / 1e3).toLocaleString("en-US") + "k";
  return "$" + Math.round(n).toLocaleString("en-US");
}

// "just now", "3m ago", "2h ago", "5d ago" — from a timestamp (ms).
export function formatAgo(ts: number, now: number = Date.now()): string {
  if (!ts) return "—";
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

// short UTC date -> "Jul 1", "Jul 28" (season range labels).
const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];
export function formatDate(d: Date): string {
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}
