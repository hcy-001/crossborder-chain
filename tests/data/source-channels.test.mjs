import test from "node:test";
import assert from "node:assert/strict";
import {createServer} from "node:http";
import {readFile} from "node:fs/promises";
import {createSourceChannel, fault} from "../../channels/source/http-json.mjs";

const scope = {region: null, platform: null, category: null};

async function fixture(payload, status = 200) {
  const server = createServer((request, response) => {
    response.writeHead(status, {"content-type": "application/json"});
    response.end(JSON.stringify(payload));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const {port} = server.address();
  return {
    url: `http://127.0.0.1:${port}/rates`,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

function config(adapter, url, quote = "CNY", role = "primary") {
  return {
    id: `${adapter}-fixture`, kind: "source", adapter, url,
    source_type: adapter === "cbr" ? "official-mirror" : "official",
    requires: "none", enabled: true, ttl_hours: 24, scope,
    capabilities: {key: `fx.USD_${quote}`, base: "USD", quote, unit: `${quote}/USD`, role}
  };
}

test("Frankfurter channel parses only the requested rate", async (t) => {
  const server = await fixture({base: "USD", date: "2026-10-28", rates: {CNY: 7.1234, EUR: 0.86}});
  t.after(server.close);
  const channel = createSourceChannel(config("frankfurter", server.url));
  const result = await channel.run({nowIso: "2026-10-29T12:00:00.000Z"});
  assert.equal(result.value, 7.1234);
  assert.equal(result.unit, "CNY/USD");
  assert.equal(result.http_status, 200);
  assert.equal(result.fetched_at, "2026-10-29T12:00:00.000Z");
});

test("CBR channel reads USD/RUB without inventing unsupported currencies", async (t) => {
  const server = await fixture({
    Date: "2026-10-29T09:00:00+03:00",
    Valute: {
      USD: {Value: 81.5, Nominal: 1},
      CNY: {Value: 11.45, Nominal: 1}
    }
  });
  t.after(server.close);
  const channel = createSourceChannel(config("cbr", server.url, "RUB"));
  const result = await channel.run({nowIso: "2026-10-29T12:00:00.000Z"});
  assert.equal(result.value, 81.5);
  assert.equal(result.unit, "RUB/USD");
  assert.equal(result.source_type, "official-mirror");
});

test("CBR USD/CNY value is explicitly derived from two RUB quotes", async (t) => {
  const server = await fixture({
    Date: "2026-10-29T09:00:00+03:00",
    Valute: {
      USD: {Value: 80, Nominal: 1},
      CNY: {Value: 40, Nominal: 4}
    }
  });
  t.after(server.close);
  const channel = createSourceChannel(config("cbr", server.url, "CNY", "cross_check"));
  const result = await channel.run({nowIso: "2026-10-29T12:00:00.000Z"});
  assert.equal(result.value, 8);
  assert.equal(result.source_type, "official-mirror");
  assert.match(result.note, /derived/);
});

test("generic HTTP JSON channel follows its declared mapping and observation time", async (t) => {
  const server = await fixture({date: "2026-10-28", rates: {CNY: 7.25}});
  t.after(server.close);
  const generic = {
    ...config("http-json", server.url),
    mapping: {
      value_path: "/rates/CNY", key: "fx.USD_CNY", unit: "CNY/USD",
      as_of_path: "/date", scale: 2
    }
  };
  const channel = createSourceChannel(generic);
  const result = await channel.run({nowIso: "2026-10-29T12:00:00.000Z"});
  assert.equal(result.value, 14.5);
  assert.equal(result.unit, "CNY/USD");
  assert.equal(result.note, "provider_as_of=2026-10-28");
});

test("a third same-shape JSON source needs only a sources.json entry", async (t) => {
  const server = await fixture({date: "2026-10-28", rates: {CNY: 7.25}});
  t.after(server.close);
  const sources = JSON.parse(await readFile(new URL("../../data/sources.json", import.meta.url), "utf8"));
  sources.push({
    id: "third-usd-cny-fixture", kind: "source", adapter: "http-json", url: server.url,
    source_type: "official", requires: "none", enabled: true, ttl_hours: 24, scope,
    pair: "USD_CNY", role: "cross-check",
    mapping: {
      value_path: "/rates/CNY", key: "fx.USD_CNY", unit: "CNY/USD",
      as_of_path: "/date", cost_direction: "higher_is_worse"
    }
  });
  const result = await createSourceChannel(sources.at(-1)).run({
    nowIso: "2026-10-29T12:00:00.000Z"
  });
  assert.equal(result.value, 7.25);
  assert.equal(result.source_type, "official");
  assert.equal(result.note, "provider_as_of=2026-10-28");
});

test("HTTP and missing-data failures are not converted into rates", async (t) => {
  const server = await fixture({rates: {}}, 503);
  t.after(server.close);
  const channel = createSourceChannel(config("frankfurter", server.url));
  await assert.rejects(channel.run({}), (error) => error.http_status === 503);
  assert.equal(fault(Object.assign(new Error("busy"), {http_status: 503})), "transient");
  const probe = await channel.probe();
  assert.equal(probe.ok, false);
  assert.equal(probe.http_status, 503);
});
