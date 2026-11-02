import {mkdir, writeFile} from "node:fs/promises";
import {join, resolve} from "node:path";

function parseArgs(args) {
  let id = null;
  let root = process.cwd();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg.startsWith("--id=")) id = arg.slice(5);
    else if (arg === "--id") id = args[++index];
    else if (arg === "--root" && args[index + 1]) root = args[++index];
    else throw new Error("usage: add-region --id=XX [--root <dir>]");
  }
  if (!id || !/^[A-Z]{2}$/.test(id)) throw new Error("region id must be ISO 3166-1 alpha-2 uppercase");
  return {id, root: resolve(root)};
}

const {id, root} = parseArgs(process.argv.slice(2));
const regionRoot = join(root, "regions", id);
const files = [
  ["profile.json", {
    id,
    regime: "unverified",
    locales: [`und-${id}`],
    currency: "XXX",
    price_rounding: null,
    platforms: ["unassigned"],
    completion: "skeleton",
    signal_sources: {allowed: [], blocked: []}
  }],
  ["platforms/unassigned.json", {status: "unverified", facts: []}],
  ["compliance/rules.json", {notes: "unverified", rules: []}],
  ["sources.json", []]
];

try {
  for (const [relativePath, value] of files) {
    const file = join(regionRoot, relativePath);
    await mkdir(join(file, ".."), {recursive: true});
    await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, {encoding: "utf8", flag: "wx"});
    console.log(`regions/${id}/${relativePath}`);
  }
} catch (error) {
  console.error(`add-region failed: ${error.message}`);
  process.exitCode = 1;
}
