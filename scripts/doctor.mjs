import {runDoctor} from "./lib/preflight.mjs";

function parseArgs(args) {
  const options = {root: process.cwd(), nowIso: new Date().toISOString()};
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--root" && args[index + 1]) options.root = args[++index];
    else if (args[index] === "--now" && args[index + 1]) options.nowIso = args[++index];
    else throw new Error("usage: doctor [--root <dir>] [--now <ISO8601>]");
  }
  return options;
}

try {
  const options = parseArgs(process.argv.slice(2));
  const result = await runDoctor(options);
  if (!result.ok) {
    console.log(JSON.stringify({ok: false, exitCode: 1, status: "hard_failure", error: result.state.error}, null, 2));
    process.exitCode = 1;
  } else {
    const counts = result.state.receipts.reduce((summary, receipt) => {
      summary[receipt.status] = (summary[receipt.status] ?? 0) + 1;
      return summary;
    }, {});
    console.log(JSON.stringify({
      ok: true,
      exitCode: 0,
      run_id: result.state.run_id,
      snapshot_id: result.state.run_id,
      status: result.state.status,
      pricing: result.state.pricing,
      receipt_counts: counts,
      sources_sha256: result.state.sources_sha256,
      snapshot_sha256: result.state.snapshot_sha256
    }, null, 2));
  }
} catch (error) {
  console.log(JSON.stringify({ok: false, exitCode: 1, status: "hard_failure", error: {message: error.message}}, null, 2));
  process.exitCode = 1;
}
