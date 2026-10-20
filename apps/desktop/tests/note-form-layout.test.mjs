import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(resolve(here, "../src/renderer/index.html"), "utf8");
const css = readFileSync(resolve(here, "../src/renderer/workspace.css"), "utf8");

test("local note composer uses a compact vertical layout", () => {
  const form = html.slice(html.indexOf('<form id="note-form"'), html.indexOf('</form>', html.indexOf('<form id="note-form"')));
  assert.ok(form.indexOf('note-form-head') < form.indexOf('note-input'));
  assert.ok(form.indexOf('note-input') < form.indexOf('note-form-footer'));
  assert.ok(form.indexOf('只保存在本机，不派工') < form.indexOf('add-note'));
  assert.match(css, /form\.note-form\s*\{[^}]*flex-direction:\s*column/s);
  assert.match(css, /width:\s*min\(420px, calc\(100% - 24px\)\)/);
  assert.match(css, /form\.note-form #note-input\s*\{[^}]*width:\s*100%/s);
});
