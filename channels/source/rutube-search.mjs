const endpoint = "https://rutube.ru/api/search/video/";

export const meta = {
  name: "rutube-public-search",
  kind: "source",
  requires: "none",
  capabilities: {search: true},
  cost: 0
};

function statusOf(error) {
  return Number(error?.http_status ?? error?.status ?? error?.statusCode ?? error?.response?.status);
}

export function fault(error) {
  const status = statusOf(error);
  const code = error?.code ?? error?.cause?.code ?? "";
  const text = `${code} ${error?.name ?? ""} ${error?.message ?? ""}`.toLowerCase();

  if (status === 402 || /insufficient[_ -]?quota|billing|payment required/.test(text)) {
    return "billing";
  }
  if (/moderation|content[_ -]?policy|content filter|safety/.test(text)) {
    return "moderation";
  }
  if (status === 429 || /rate[_ -]?limit|too many requests/.test(text)) {
    return "rate";
  }
  if (status === 408 || (status >= 500 && status <= 599) ||
      /eai_again|econnaborted|econnrefused|econnreset|enotfound|etimedout|timeouterror|aborterror|timeout|temporarily unavailable/.test(text)) {
    return "transient";
  }
  return "unknown";
}

function searchUrl(query, page) {
  return `${endpoint}?query=${encodeURIComponent(query)}&page=${page}`;
}

function dataAsOf(publicationTs) {
  if (typeof publicationTs !== "string" || !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(publicationTs.trim())) {
    return null;
  }
  const timestamp = Date.parse(publicationTs);
  return Number.isNaN(timestamp) ? null : new Date(timestamp).toISOString();
}

function failure(url, error) {
  const status = statusOf(error);
  return {
    ok: false,
    signals: [],
    receipt: {
      source: meta.name,
      url,
      fetched_at: new Date().toISOString(),
      ...(Number.isFinite(status) ? {http_status: status} : {}),
      error: {
        code: error?.code ?? error?.name ?? "SOURCE_ERROR",
        message: error instanceof Error ? error.message : String(error),
        fault: fault(error)
      }
    }
  };
}

export async function run({query, page = 1, fetchImpl = globalThis.fetch, signal} = {}) {
  const normalizedQuery = typeof query === "string" ? query.trim() : "";
  const url = searchUrl(normalizedQuery, Number.isInteger(page) ? page : 1);
  if (!normalizedQuery || !Number.isInteger(page) || page < 1) {
    return failure(url, Object.assign(new Error("query must be non-empty and page must be a positive integer"), {
      code: "INVALID_INPUT"
    }));
  }
  if (typeof fetchImpl !== "function") {
    return failure(url, Object.assign(new Error("Fetch is unavailable"), {code: "FETCH_UNAVAILABLE"}));
  }

  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: {accept: "application/json"},
      signal
    });
    if (!response.ok) {
      throw Object.assign(new Error(`Rutube HTTP ${response.status}`), {
        code: `HTTP_${response.status}`,
        http_status: response.status
      });
    }
    const payload = await response.json();
    if (!Array.isArray(payload?.results)) {
      throw Object.assign(new Error("Rutube response has no results array"), {code: "INVALID_RESPONSE"});
    }

    const fetchedAt = new Date().toISOString();
    const signals = payload.results.map((item) => ({
      source: meta.name,
      url: typeof item.video_url === "string" && item.video_url.startsWith("https://") ? item.video_url : url,
      fetched_at: fetchedAt,
      data_as_of: dataAsOf(item.publication_ts),
      reporting_lag: null,
      is_realtime: false,
      raw: item,
      confidence: "official"
    }));
    return {
      ok: true,
      signals,
      receipt: {
        source: meta.name,
        url,
        fetched_at: fetchedAt,
        http_status: response.status,
        count: Number.isFinite(payload.count) ? payload.count : signals.length
      }
    };
  } catch (error) {
    return failure(url, error);
  }
}

export async function probe(input = {}) {
  return run(input);
}
