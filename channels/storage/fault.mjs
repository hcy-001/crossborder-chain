export function classifyFault(error) {
  const status = Number(error?.status ?? error?.statusCode ?? error?.response?.status);
  const code = error?.code ?? error?.cause?.code ?? "";
  const text = `${code} ${error?.type ?? ""} ${error?.message ?? ""}`.toLowerCase();

  if (status === 402 || /insufficient[_ -]?quota|billing|payment required|credit balance/.test(text)) {
    return "billing";
  }
  if (/moderation|content[_ -]?policy|content filter|safety/.test(text)) {
    return "moderation";
  }
  if (status === 429 || /rate[_ -]?limit|too many requests/.test(text)) {
    return "rate";
  }
  if ([408, 500, 502, 503, 504].includes(status)
    || /eai_again|econnaborted|econnrefused|econnreset|etimedout|timeout|temporarily unavailable/.test(text)) {
    return "transient";
  }
  return "unknown";
}
