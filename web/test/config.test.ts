import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { buildOpenCodeConfigContent, loadConfig } from "../src/config.js";

test("loadConfig applies defaults for an empty environment", () => {
  const config = loadConfig({});

  assert.equal(config.port, 8080);
  assert.equal(config.host, "0.0.0.0");
  assert.equal(config.requireModel, true);
  assert.equal(config.vectorDbLimit, 5);
  assert.equal(config.vectorDbCollection, "knowledge");
  assert.equal(config.openCodeModel, undefined);
  assert.equal(config.vectorDbUrl, undefined);
});

test("loadConfig coerces numeric strings and validates ranges", () => {
  const config = loadConfig({ PORT: "9090", VECTOR_DB_LIMIT: "3" });
  assert.equal(config.port, 9090);
  assert.equal(config.vectorDbLimit, 3);

  assert.throws(() => loadConfig({ PORT: "0" }));
  assert.throws(() => loadConfig({ PORT: "not-a-port" }));
  assert.throws(() => loadConfig({ VECTOR_DB_LIMIT: "999" }));
});

test("loadConfig understands boolean-like values", () => {
  for (const value of ["1", "true", "TRUE", "yes", "on"]) {
    assert.equal(loadConfig({ REQUIRE_MODEL: value }).requireModel, true, value);
  }
  for (const value of ["0", "false", "no", "off", ""]) {
    assert.equal(loadConfig({ REQUIRE_MODEL: value }).requireModel, false, value);
  }
  assert.throws(() => loadConfig({ REQUIRE_MODEL: "maybe" }));
});

test("loadConfig trims strings and treats blanks as unset", () => {
  const config = loadConfig({
    OPENCODE_MODEL: "  mock/mock-model  ",
    OPENCODE_AGENT: "   ",
    VECTOR_DB_URL: " http://vector-db:8080/// ",
  });

  assert.equal(config.openCodeModel, "mock/mock-model");
  assert.equal(config.openCodeAgent, undefined);
  assert.equal(config.vectorDbUrl, "http://vector-db:8080");
});

test("loadConfig resolves filesystem paths", () => {
  const config = loadConfig({
    WORKSPACE_DIR: "workspace",
    OPENCODE_DB_PATH: "./data/opencode.db",
  });

  assert.equal(config.workspaceDir, path.resolve("workspace"));
  assert.equal(config.openCodeDbPath, path.resolve("./data/opencode.db"));
});

test("buildOpenCodeConfigContent passes raw JSON through unchanged", () => {
  const raw = '{"$schema":"https://opencode.ai/config.json","model":"mock/mock-model"}';
  const config = loadConfig({ OPENCODE_CONFIG_JSON: raw, OPENCODE_MODEL: "ignored/model" });

  assert.equal(buildOpenCodeConfigContent(config), raw);
});

test("buildOpenCodeConfigContent generates a minimal config", () => {
  const config = loadConfig({
    OPENCODE_MODEL: "opencode/deepseek-v4.1-flash-free",
    OPENCODE_AGENT: "build",
  });
  const parsed = JSON.parse(buildOpenCodeConfigContent(config)) as Record<string, unknown>;

  assert.equal(parsed.$schema, "https://opencode.ai/config.json");
  assert.equal(parsed.model, "opencode/deepseek-v4.1-flash-free");
  assert.equal(parsed.default_agent, "build");
});

test("buildOpenCodeConfigContent omits optional fields when unset", () => {
  const parsed = JSON.parse(buildOpenCodeConfigContent(loadConfig({}))) as Record<string, unknown>;

  assert.equal(parsed.model, undefined);
  assert.equal(parsed.default_agent, undefined);
});
