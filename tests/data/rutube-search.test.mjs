import test from "node:test";
import assert from "node:assert/strict";
import {createServer} from "node:http";
import {readFile} from "node:fs/promises";
import Ajv2020 from "ajv/dist/2020.js";
import {meta, probe, run, fault} from "../../channels/source/rutube-search.mjs";

const schema = JSON.parse(await readFile(new URL("../../schemas/signal.schema.json", import.meta.url), "utf8"));
const validate = new Ajv2020().compile(schema);

async function fixture(t, handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const {port} = server.address();
  const requests = [];
  return {
    requests,
    fetchImpl(url, options) {
      requests.push({url, options});
      return fetch(`http://127.0.0.1:${port}/fixture`, options);
    }
  };
}

function jsonHandler(payload, status = 200) {
  return (request, response) => {
    response.writeHead(status, {"content-type": "application/json"});
    response.end(JSON.stringify(payload));
  };
}

const baseResult = {
  id: 123,
  title: "Женская куртка",
  description: "Демисезонная куртка",
  hits: 456,
  publication_ts: "2026-10-29T12:00:00",
  last_update_ts: "2026-10-29T13:00:00",
  video_url: "https://rutube.ru/video/example/",
  author: {name: "Автор"},
  category: {name: "Мода"}
};

test("Rutube search maps public results to schema-valid signals with one GET", async (t) => {
  const server = await fixture(t, jsonHandler({count: 1, results: [baseResult]}));
  const result = await run({query: "женская куртка", page: 1, fetchImpl: server.fetchImpl});

  assert.equal(result.ok, true);
  assert.equal(result.signals.length, 1);
  assert.equal(result.receipt.http_status, 200);
  assert.equal(result.receipt.count, 1);
  assert.equal(server.requests.length, 1);
  const request = new URL(server.requests[0].url);
  assert.equal(request.origin + request.pathname, "https://rutube.ru/api/search/video/");
  assert.equal(request.searchParams.get("query"), "женская куртка");
  assert.equal(request.searchParams.get("page"), "1");
  assert.equal(server.requests[0].options.method, "GET");

  const signal = result.signals[0];
  assert.equal(validate(signal), true, JSON.stringify(validate.errors));
  assert.equal(signal.source, "rutube-public-search");
  assert.equal(signal.url, baseResult.video_url);
  assert.equal(signal.data_as_of, null, "naive publication_ts must not be assumed to be UTC");
  assert.equal(signal.reporting_lag, null);
  assert.equal(signal.is_realtime, false);
  assert.equal(signal.confidence, "official");
  assert.deepEqual(signal.raw, baseResult);
});

test("Rutube search converts only publication_ts with an explicit timezone", async (t) => {
  const results = [
    {...baseResult, id: 1, publication_ts: "2026-10-29T12:00:00+03:00"},
    {...baseResult, id: 2, publication_ts: "2026-10-29T09:00:00.123Z"},
    {...baseResult, id: 3, publication_ts: "2026-10-29 12:00:00"}
  ];
  const server = await fixture(t, jsonHandler({count: 3, results}));
  const result = await run({query: "куртка", fetchImpl: server.fetchImpl});

  assert.equal(result.ok, true);
  assert.deepEqual(result.signals.map((signal) => signal.data_as_of), [
    "2026-10-29T09:00:00.000Z",
    "2026-10-29T09:00:00.123Z",
    null
  ]);
  assert.equal(result.signals[2].raw.publication_ts, "2026-10-29 12:00:00");
  for (const signal of result.signals) {
    assert.equal(validate(signal), true, JSON.stringify(validate.errors));
  }
});

for (const [status, expectedFault] of [[403, "unknown"], [502, "transient"]]) {
  test(`Rutube search degrades HTTP ${status} without emitting signals`, async (t) => {
    const server = await fixture(t, jsonHandler({error: "unavailable"}, status));
    const result = await run({query: "куртка", fetchImpl: server.fetchImpl});

    assert.equal(result.ok, false);
    assert.deepEqual(result.signals, []);
    assert.equal(result.receipt.http_status, status);
    assert.equal(result.receipt.error.fault, expectedFault);
    assert.equal(server.requests.length, 1);
  });
}

test("Rutube search degrades timeouts without emitting signals", async (t) => {
  const server = await fixture(t, (request, response) => {
    const timer = setTimeout(() => {
      response.writeHead(200, {"content-type": "application/json"});
      response.end(JSON.stringify({count: 0, results: []}));
    }, 200);
    response.on("close", () => clearTimeout(timer));
  });
  const result = await run({
    query: "куртка",
    fetchImpl: server.fetchImpl,
    signal: AbortSignal.timeout(20)
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.signals, []);
  assert.equal(result.receipt.error.fault, "transient");
});

test("Rutube probe is read-only and performs exactly one request", async (t) => {
  const server = await fixture(t, jsonHandler({count: 0, results: []}));
  const result = await probe({query: "куртка", page: 2, fetchImpl: server.fetchImpl});

  assert.equal(result.ok, true);
  assert.equal(server.requests.length, 1);
  assert.equal(server.requests[0].options.method, "GET");
  assert.deepEqual(Object.keys(server.requests[0].options.headers), ["accept"]);
});

test("Rutube metadata and five fault classes are explicit", () => {
  assert.deepEqual(meta, {
    name: "rutube-public-search",
    kind: "source",
    requires: "none",
    capabilities: {search: true},
    cost: 0
  });
  assert.equal(fault({http_status: 402}), "billing");
  assert.equal(fault({code: "CONTENT_POLICY"}), "moderation");
  assert.equal(fault({http_status: 429}), "rate");
  assert.equal(fault({http_status: 503}), "transient");
  assert.equal(fault({http_status: 403}), "unknown");
});
