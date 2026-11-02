const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function timestamp(value, field) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new TypeError(`Invalid ${field} timestamp`);
  }
  return parsed;
}

export function assessFact(fact, nowIso) {
  if (!fact || !Number.isFinite(Date.parse(fact.fetched_at)) ||
      !Number.isFinite(fact.ttl_hours) || fact.ttl_hours <= 0) {
    return {status: "missing", expiredDays: null};
  }
  const expiresAt = timestamp(fact.fetched_at, "fetched_at") + fact.ttl_hours * HOUR_MS;
  const elapsedMs = timestamp(nowIso, "nowIso") - expiresAt;
  if (elapsedMs <= 0) {
    return {status: "fresh", expiredDays: 0};
  }
  return {status: "stale", expiredDays: Math.floor(elapsedMs / DAY_MS)};
}
