import {mkdir} from "node:fs/promises";
import {join} from "node:path";
import sharp from "sharp";
import {classifyFault} from "./fault.mjs";

export const meta = {
  name: "mock",
  kind: "imagegen",
  requires: "none",
  capabilities: {placeholder: true},
  cost: {currency: "CNY", unit_price: 0}
};

export async function probe() {
  return {ok: true, detail: "ready"};
}

function positiveInteger(value, name) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
}

export async function run({width, height, count, outputDir} = {}) {
  positiveInteger(width, "width");
  positiveInteger(height, "height");
  positiveInteger(count, "count");
  if (typeof outputDir !== "string" || outputDir.length === 0) {
    throw new TypeError("outputDir is required");
  }

  await mkdir(outputDir, {recursive: true});
  const files = [];
  for (let index = 0; index < count; index += 1) {
    const number = String(index + 1).padStart(2, "0");
    const file = join(outputDir, `mock-${number}.png`);
    const fontSize = Math.max(12, Math.round(Math.min(width, height) / 18));
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <rect width="100%" height="100%" fill="#315b7d"/>
  <rect x="${(index % 3) * width / 3}" y="${Math.floor(index / 3) * height / 3}" width="${width / 3}" height="${height / 3}" fill="#173247"/>
  <text x="50%" y="44%" text-anchor="middle" fill="#ffffff" font-family="sans-serif" font-size="${fontSize}" font-weight="700">MOCK ${number}</text>
  <text x="50%" y="54%" text-anchor="middle" fill="#ffffff" font-family="sans-serif" font-size="${fontSize}">${width} x ${height}</text>
  <text x="50%" y="63%" text-anchor="middle" fill="#ffffff" font-family="sans-serif" font-size="${Math.max(10, Math.round(fontSize * 0.55))}">PLACEHOLDER - NOT FOR PUBLISHING</text>
</svg>`;
    await sharp(Buffer.from(svg)).png().toFile(file);
    files.push(file);
  }

  return {
    ok: true,
    files,
    quality: "placeholder",
    meta: {quality: "placeholder", width, height, count},
    usage: {images: count, unit_price: 0}
  };
}

export function fault(error) {
  return classifyFault(error);
}
