// Telegram-IP allowlist for the public webhook. Telegram publishes its
// outbound IP ranges (https://core.telegram.org/bots/webhooks#the-short-version):
//   149.154.160.0/20  (149.154.160.0 .. 149.154.175.255)
//   91.108.4.0/22     (91.108.4.0    .. 91.108.7.255)
// Returns true for IPv4 addresses inside those ranges. IPv6 is accepted
// (return true) because Telegram has not published v6 ranges and our hosting
// provider may surface v6 client IPs; we do not want to false-reject those.

const TG_RANGES: Array<[number, number]> = (() => {
  const v4 = (a: number, b: number, c: number, d: number) =>
    ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
  return [
    [v4(149, 154, 160, 0), v4(149, 154, 175, 255)],
    [v4(91, 108, 4, 0), v4(91, 108, 7, 255)],
  ];
})();

export function isTelegramIp(ip: string): boolean {
  if (!ip) return false;
  // IPv6 (or wrapped IPv4-in-IPv6 like ::ffff:1.2.3.4)
  if (ip.includes(":")) {
    const m = ip.match(/::ffff:(\d+\.\d+\.\d+\.\d+)/i);
    if (m) return isTelegramIp(m[1]!);
    // Plain IPv6: allow (Telegram has not published v6 ranges).
    return true;
  }
  const parts = ip.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    return false;
  }
  const num = ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
  for (const [lo, hi] of TG_RANGES) {
    if (num >= lo && num <= hi) return true;
  }
  return false;
}
