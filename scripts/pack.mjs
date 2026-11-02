import {runPackage} from "./lib/package-runner.mjs";

function parseArgs(args) {
  const sku = args[0];
  if (!sku || !/^[a-z0-9][a-z0-9-]*$/.test(sku)) throw new Error("usage: pack <sku> [--root <dir>] [--now <ISO8601>]");
  const options = {root: process.cwd(), nowIso: new Date().toISOString()};
  for (let index = 1; index < args.length; index += 1) {
    if (args[index] === "--root" && args[index + 1]) options.root = args[++index];
    else if (args[index] === "--now" && args[index + 1]) options.nowIso = args[++index];
    else throw new Error("usage: pack <sku> [--root <dir>] [--now <ISO8601>]");
  }
  return {sku, ...options};
}

try {
  const options = parseArgs(process.argv.slice(2));
  const result = await runPackage(options);
  console.log(JSON.stringify({ok: true, package: result.packageDir, run_id: result.receipt.run_id, pricing: result.receipt.pricing.status}, null, 2));
} catch (error) {
  console.error(JSON.stringify({ok: false, status: "hard_failure", error: error.message}));
  process.exitCode = 1;
}
