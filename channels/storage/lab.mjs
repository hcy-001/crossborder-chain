import {createHash} from "node:crypto";
import {mkdir, readFile, writeFile} from "node:fs/promises";
import {extname, join} from "node:path";
import {classifyFault} from "./fault.mjs";

export const meta = {
  name: "lab",
  kind: "storage",
  requires: "none",
  capabilities: {contentAddressed: true, publicUrl: false},
  cost: {currency: "CNY", unit_price: 0}
};

export async function probe() {
  return {ok: true, detail: "ready"};
}

export async function run({files, outputDir} = {}) {
  if (!Array.isArray(files)) throw new TypeError("files must be an array");
  if (typeof outputDir !== "string" || outputDir.length === 0) {
    throw new TypeError("outputDir is required");
  }
  await mkdir(outputDir, {recursive: true});

  const stored = [];
  const manifestFiles = [];
  let totalBytes = 0;
  for (let index = 0; index < files.length; index += 1) {
    const contents = await readFile(files[index]);
    const sha256 = createHash("sha256").update(contents).digest("hex");
    const number = String(index + 1).padStart(2, "0");
    const name = `img-${number}-${sha256.slice(0, 8)}${extname(files[index])}`;
    const output = join(outputDir, name);
    await writeFile(output, contents);
    stored.push(output);
    manifestFiles.push({name, sha256, bytes: contents.length});
    totalBytes += contents.length;
  }

  const manifest = join(outputDir, "manifest.json");
  await writeFile(manifest, `${JSON.stringify({files: manifestFiles}, null, 2)}\n`, "utf8");
  return {ok: true, files: stored, meta: {manifest}, usage: {bytes: totalBytes}};
}

export function fault(error) {
  return classifyFault(error);
}
