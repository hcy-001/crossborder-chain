import test from "node:test";
import assert from "node:assert/strict";
import {readFile, readdir, stat} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import {join} from "node:path";
import Ajv2020 from "ajv/dist/2020.js";

const schema = JSON.parse(await readFile(new URL("../../schemas/profile.schema.json", import.meta.url), "utf8"));
const regionsDir = new URL("../../regions/", import.meta.url);
const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const expected = ["RU", "SA", "AE", "ID", "TH", "VN", "PH", "MY", "SG"];

const exists = (file) => stat(file).then(() => true).catch(() => false);

test("all nine region profiles are schema-valid and completion matches the artifacts that actually exist", async () => {
  const validate = new Ajv2020().compile(schema);
  const ids = await readdir(regionsDir);
  assert.deepEqual(ids.sort(), [...expected].sort());

  for (const id of expected) {
    const profile = JSON.parse(await readFile(new URL(`${id}/profile.json`, regionsDir), "utf8"));
    assert.equal(validate(profile), true, `${id}: ${JSON.stringify(validate.errors)}`);
    assert.equal(profile.id, id);

    const hasRules = await exists(join(projectRoot, "regions", id, "compliance", "rules.json"));
    const specChecks = await Promise.all(profile.platforms.map((platform) =>
      exists(join(projectRoot, "data/specs/platforms", `${platform}.json`))
    ));
    const hasAllSpecs = specChecks.every(Boolean);
    const artifactsComplete = hasRules && hasAllSpecs;

    if (profile.completion === "full") {
      assert.ok(hasRules, `${id}: completion=full 缺 compliance/rules.json`);
      assert.ok(hasAllSpecs, `${id}: completion=full 缺平台规格 ${JSON.stringify(profile.platforms)}`);
    }
    assert.equal(
      profile.completion === "full",
      artifactsComplete,
      `${id}: completion 必须与证据一致（rules=${hasRules}, specs=${hasAllSpecs}）`
    );
  }
});
