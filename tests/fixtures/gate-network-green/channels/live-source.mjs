export const meta = {name: "fixture-source", kind: "source", requires: "none", capabilities: {}, cost: {currency: "CNY", unit_price: 0}};

export async function probe({url, fetchImpl = globalThis.fetch} = {}) {
  const response = await fetchImpl(url, {headers: {accept: "application/json"}});
  return {ok: response.ok, status: response.status};
}
