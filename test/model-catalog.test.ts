import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createModelCatalogReader, normalizeModels, queryCodexModels } from "../src/model-catalog.js";
import { resolveDirectModel } from "../src/backends/direct/models.js";

const model = { id: "future-model", displayName: "Future", reasoningLevels: ["high", "new-effort"], defaultReasoning: "high", inputModalities: ["text", "image"] };

test("catalog preserves advertised order and future effort names, filters hidden models and sanitizes fields", () => {
  assert.deepEqual(normalizeModels([
    { model: "future-model", displayName: "Future", supportedReasoningEfforts: [{ reasoningEffort: "high" }, { reasoningEffort: "new-effort" }], defaultReasoningEffort: "high", inputModalities: ["text", "image"], secret: "never-return" },
    { model: "hidden", hidden: true }, null,
  ]), [model]);
});

test("catalog deduplicates refresh, respects TTL, and shares dynamic efforts with Direct validation", async () => {
  const home = mkdtempSync(join(tmpdir(), "catalog-"));
  let calls = 0; let clock = 0;
  const read = createModelCatalogReader(home, async () => { calls++; return [model]; }, () => clock);
  try {
    await Promise.all([read(), read(true)]);
    assert.equal(calls, 1);
    assert.deepEqual(resolveDirectModel(home, model.id, "high").supportedReasoning, model.reasoningLevels);
    await read(true); assert.equal(calls, 1);
    clock = 16_000; await read(true); assert.equal(calls, 2);
    clock = 20_000; await read(); assert.equal(calls, 2);
    clock = 400_000; await read(); assert.equal(calls, 3);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("offline catalog falls back to disk with stale marker and never exposes raw cache fields", async () => {
  const home = mkdtempSync(join(tmpdir(), "catalog-offline-"));
  try {
    writeFileSync(join(home, "models_cache.json"), JSON.stringify({ fetched_at: "2026-10-05T00:00:00Z", models: [
      { slug: "disk", visibility: "list", supported_reasoning_levels: [{ effort: "medium" }], base_instructions: "private" },
      { slug: "hidden", visibility: "hide" },
    ] }));
    const read = createModelCatalogReader(home, async () => { throw new Error("secret upstream details"); });
    const result = await read();
    assert.equal(result.stale, true); assert.equal(result.source, "codex-model-cache");
    assert.equal(result.models[0]?.id, "disk"); assert.equal(result.models.length, 1);
    assert.doesNotMatch(JSON.stringify(result), /private|secret/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("failed refresh preserves last successful catalog; missing cache returns empty explicit fallback", async () => {
  const home = mkdtempSync(join(tmpdir(), "catalog-stale-"));
  let clock = 0;
  const read = createModelCatalogReader(home, async () => { if (clock) throw new Error(); return [model]; }, () => clock);
  try {
    await read(); clock = 400_000;
    const result = await read(); assert.equal(result.stale, true); assert.deepEqual(result.models, [model]);
    const empty = await createModelCatalogReader(home, async () => { throw new Error(); })();
    assert.deepEqual(empty.models, []);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("app-server adapter handles initialize, pagination, process failures and timeout", async () => {
  const home = mkdtempSync(join(tmpdir(), "catalog-rpc-"));
  const binary = join(home, "fake-codex");
  try {
    writeFileSync(binary, `#!${process.execPath}
const readline=require('node:readline');
readline.createInterface({input:process.stdin}).on('line', line => {
 const m=JSON.parse(line);
 if(m.method==='initialize') console.log(JSON.stringify({id:m.id,result:{}}));
 if(m.method==='model/list') console.log(JSON.stringify({id:m.id,result:{data:[{model:m.params.cursor?'second':'first',supportedReasoningEfforts:[{reasoningEffort:'medium'}]}],nextCursor:m.params.cursor?null:'page2'}}));
});\n`, { mode: 0o700 });
    const models = await queryCodexModels(home, binary, 2_000);
    assert.deepEqual(models.map(m => m.id), ["first", "second"]);
    await assert.rejects(queryCodexModels(home, join(home, "missing"), 1_000), /unavailable/);
    writeFileSync(binary, `#!${process.execPath}\nsetInterval(()=>{},1000);\n`, { mode: 0o700 });
    await assert.rejects(queryCodexModels(home, binary, 100), /timed out/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
