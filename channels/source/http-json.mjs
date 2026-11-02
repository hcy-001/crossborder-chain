import {parseFrankfurter} from "./frankfurter.mjs";
import {parseCbr} from "./cbr.mjs";

function pointer(payload, path) {
  return path.slice(1).split("/").filter(Boolean).reduce((value, token) => {
    const key = token.replaceAll("~1", "/").replaceAll("~0", "~");
    return value?.[key];
  }, payload);
}

function parseJsonMapping(payload, config) {
  const mapping = config.mapping;
  const rawValue = mapping ? pointer(payload, mapping.value_path) : undefined;
  if (!Number.isFinite(rawValue)) {
    throw Object.assign(new Error(`No numeric value at ${mapping?.value_path}`), {code: "NO_DATA"});
  }
  const asOf = mapping.as_of_path ? pointer(payload, mapping.as_of_path) : undefined;
  if (mapping.as_of_path && (asOf === undefined || asOf === null || asOf === "")) {
    throw Object.assign(new Error(`No observation time at ${mapping.as_of_path}`), {code: "NO_DATA"});
  }
  return {
    value: rawValue * (mapping.scale ?? 1),
    unit: mapping.unit,
    ...(asOf !== undefined ? {note: `provider_as_of=${asOf}`} : {})
  };
}

const parsers = {frankfurter: parseFrankfurter, cbr: parseCbr, "http-json": parseJsonMapping};

function sourceKey(source) {
  return source.mapping?.key ?? source.capabilities?.key;
}

export function fault(error) {
  const status = error?.http_status;
  if (status === 402 || error?.code === "BILLING") return "billing";
  if (status === 429 || error?.code === "RATE_LIMIT") return "rate";
  if (status === 408 || (status >= 500 && status <= 599) ||
      ["ETIMEDOUT", "ABORT_ERR", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN"].includes(error?.code)) {
    return "transient";
  }
  return "unknown";
}

export function createSourceChannel(sourceConfig, {fetchImpl = globalThis.fetch} = {}) {
  const run = async (input = {}) => {
    if (sourceConfig.enabled === false) {
      throw Object.assign(new Error(`Source ${sourceConfig.id} is disabled`), {code: "SOURCE_DISABLED"});
    }
    const parser = parsers[sourceConfig.adapter];
    if (!parser) {
      throw Object.assign(new Error(`Unsupported source adapter ${sourceConfig.adapter}`), {
        code: "ADAPTER_UNAVAILABLE"
      });
    }
    if (typeof fetchImpl !== "function") {
      throw Object.assign(new Error("Fetch is unavailable"), {code: "FETCH_UNAVAILABLE"});
    }

    let response;
    try {
      response = await fetchImpl(sourceConfig.url, {
        headers: {accept: "application/json"},
        signal: AbortSignal.timeout(sourceConfig.capabilities?.timeout_ms ?? 10000)
      });
    } catch (error) {
      if (error?.name === "TimeoutError") error.code = "ETIMEDOUT";
      if (error?.name === "AbortError") error.code = "ABORT_ERR";
      throw error;
    }
    if (!response.ok) {
      throw Object.assign(new Error(`HTTP ${response.status} from ${sourceConfig.id}`), {
        code: `HTTP_${response.status}`,
        http_status: response.status
      });
    }
    const payload = await response.json();
    const parsed = parser(payload, sourceConfig);
    return {
      ok: true,
      ...parsed,
      source_url: sourceConfig.url,
      source_type: sourceConfig.source_type,
      fetched_at: input.nowIso ?? new Date().toISOString(),
      ttl_hours: sourceConfig.ttl_hours,
      http_status: response.status
    };
  };

  const probe = async (input = {}) => {
    try {
      const result = await run(input);
      return {
        ...result,
        key: sourceKey(sourceConfig),
        source: sourceConfig.id,
        detail: `HTTP ${result.http_status}; ${sourceKey(sourceConfig)}=${result.value} ${result.unit}`
      };
    } catch (error) {
      return {
        ok: false,
        key: sourceKey(sourceConfig),
        source: sourceConfig.id,
        detail: error instanceof Error ? error.message : String(error),
        error: {
          code: error?.code ?? "SOURCE_ERROR",
          message: error instanceof Error ? error.message : String(error),
          fault: fault(error)
        },
        ...(error?.http_status ? {http_status: error.http_status} : {})
      };
    }
  };

  return {
    ...sourceConfig,
    meta: {
      name: sourceConfig.id,
      kind: "source",
      requires: sourceConfig.requires,
      capabilities: sourceConfig.capabilities ?? {},
      cost: {currency: "CNY", unit_price: 0}
    },
    probe,
    run,
    fault
  };
}
