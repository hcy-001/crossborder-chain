import {pathToFileURL} from "node:url";

export const defaultConfig = {
  id: "cbr-usd-rub",
  kind: "source",
  adapter: "cbr",
  url: "https://www.cbr-xml-daily.ru/daily_json.js",
  source_type: "official-mirror",
  requires: "none",
  enabled: true,
  ttl_hours: 24,
  scope: {region: null, platform: null, category: null},
  pair: "USD_RUB",
  role: "primary",
  capabilities: {
    key: "fx.USD_RUB", base: "USD", quote: "RUB", unit: "RUB/USD"
  },
  mapping: {
    value_path: "/Valute/USD/Value",
    key: "fx.USD_RUB",
    unit: "RUB/USD",
    as_of_path: "/Date",
    cross_check_group: "USD_RUB",
    cost_direction: "higher_is_worse"
  }
};

function rubPerUnit(payload, currency) {
  if (currency === "RUB") return 1;
  const entry = payload?.Valute?.[currency];
  const value = entry?.Value;
  const nominal = entry?.Nominal;
  if (!Number.isFinite(value) || !Number.isFinite(nominal) || value <= 0 || nominal <= 0) {
    throw Object.assign(new Error(`CBR mirror has no usable ${currency}/RUB quote`), {code: "NO_DATA"});
  }
  return value / nominal;
}

export function parseCbr(payload, config) {
  const {base, quote, unit} = config.capabilities;
  const baseInRub = rubPerUnit(payload, base);
  const value = quote === "RUB" ? baseInRub : baseInRub / rubPerUnit(payload, quote);
  if (!Number.isFinite(value) || value <= 0) {
    throw Object.assign(new Error(`CBR mirror has no usable ${base}/${quote} rate`), {code: "NO_DATA"});
  }
  return {
    value,
    unit,
    note: quote === "RUB"
      ? `direct ${base}/RUB quote; provider_date=${payload?.Date ?? "unavailable"}`
      : `derived from ${base}/RUB and ${quote}/RUB quotes; provider_date=${payload?.Date ?? "unavailable"}`
  };
}

async function main() {
  if (process.argv[2] !== "probe") {
    console.error("Usage: node channels/source/cbr.mjs probe");
    process.exitCode = 2;
    return;
  }
  const {createSourceChannel} = await import("./http-json.mjs");
  const result = await createSourceChannel(defaultConfig).probe();
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
