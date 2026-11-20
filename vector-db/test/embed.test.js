import test from "node:test";
import assert from "node:assert/strict";

import { chunkText, embed, hashToken, tokenize } from "../src/embed.js";

test("tokenize lowercases and keeps unicode letters and digits", () => {
  assert.deepEqual(tokenize("Привет, WORLD! 42"), ["привет", "world", "42"]);
  assert.deepEqual(tokenize("   "), []);
});

test("hashToken is stable, unsigned and distinguishes inputs", () => {
  assert.equal(hashToken("docker"), hashToken("docker"));
  assert.notEqual(hashToken("docker"), hashToken("kubernetes"));

  for (const value of ["", "a", "контейнер", "x".repeat(1000)]) {
    const hash = hashToken(value);
    assert.ok(Number.isInteger(hash), value);
    assert.ok(hash >= 0 && hash <= 0xffffffff, value);
  }
});

test("embed returns a deterministic unit vector of the requested size", () => {
  const first = embed("Docker containers and images", 64);
  const second = embed("Docker containers and images", 64);

  assert.equal(first.length, 64);
  assert.deepEqual(first, second);

  const norm = Math.sqrt(first.reduce((sum, value) => sum + value * value, 0));
  assert.ok(Math.abs(norm - 1) < 1e-9, `norm=${norm}`);
});

test("embed uses a safe unit vector for empty text", () => {
  const vector = embed("   ", 8);

  assert.equal(vector.length, 8);
  assert.equal(vector[0], 1);
  assert.deepEqual(vector.slice(1), [0, 0, 0, 0, 0, 0, 0]);
});

test("similar texts score higher than unrelated ones", () => {
  const dot = (a, b) => a.reduce((sum, value, index) => sum + value * b[index], 0);

  const query = embed("docker compose networking", 256);
  const related = embed("Docker Compose connects services over a shared network.", 256);
  const unrelated = embed("Banana bread recipe with walnuts", 256);

  assert.ok(dot(query, related) > dot(query, unrelated));
});

test("chunkText returns no chunks for blank input", () => {
  assert.deepEqual(chunkText("   \n\n  ", 100, 10), []);
});

test("chunkText keeps short paragraphs together", () => {
  const text = `${"A".repeat(40)}\n\n${"B".repeat(40)}`;
  const chunks = chunkText(text, 100, 0);

  assert.equal(chunks.length, 1);
  assert.match(chunks[0], /\n\n/);
});

test("chunkText splits long paragraphs and respects overlap", () => {
  const text = "abcdefghij".repeat(30);
  const chunks = chunkText(text, 100, 0);

  assert.ok(chunks.length > 1);
  for (const chunk of chunks) assert.ok(chunk.length <= 100, `chunk=${chunk.length}`);
  assert.equal(chunks.join(""), text);

  const withOverlap = chunkText(text, 100, 20);
  assert.ok(withOverlap.length > 1);
  assert.ok(withOverlap[0].includes(withOverlap[1].slice(0, 10)));
});

test("chunkText normalises CRLF and trims", () => {
  const chunks = chunkText("  line one\r\n\r\nline two  ", 100, 10);

  assert.equal(chunks.length, 1);
  assert.equal(chunks[0], "line one\n\nline two");
});
