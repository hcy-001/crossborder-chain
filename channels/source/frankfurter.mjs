import {pathToFileURL} from "node:url";

export const defaultConfig = {
  id: "frankfurter-usd-cny",
  kind: "source",
  adapter: "frankfurter",
  url: "https://api.frankfurter.dev/v1/latest?base=USD&symbols=CNY",
  source_type: "official",
  requires: "none",
  enabled: true,
  ttl_hours: 24,
  scope: {region: null, platform: null, category: null},
  pair: "USD_CNY",
  role: "primary",
  capabilities: {
    key: "fx.USD_CNY", base: "USD", quote: "CNY", unit: "CNY/USD"
  },
  mapping: {
    value_path: "/rates/CNY",
    key: "fx.USD_CNY",
    unit: "CNY/USD",
    as_of_path: "/date",
    cross_check_group: "USD_CNY",
    cost_direction: "higher_is_worse"
  }
};

export function parseFrankfurter(payload, config) {
  const {base, quote, unit} = config.capabilities;
  const value = payload?.rates?.[quote];
  if (payload?.base !== base || !Number.isFinite(value) || value <= 0) {
    throw Object.assign(new Error(`Frankfurter has no usable ${base}/${quote} rate`), {code: "NO_DATA"});
  }
  return {
    value,
    unit,
    note: `provider_date=${payload.date ?? "unavailable"}`
  };
}

async function main() {
  if (process.argv[2] !== "probe") {
    console.error("Usage: node channels/source/frankfurter.mjs probe");
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
