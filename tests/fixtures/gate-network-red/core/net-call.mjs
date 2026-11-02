import {readFile} from "node:fs/promises";

export async function loadRate(url) {
  const response = await fetch(url);
  const body = await response.json();
  return body.rates;
}

export const readCached = async (file) => JSON.parse(await readFile(file, "utf8"));
