import test from 'node:test';
import assert from 'node:assert/strict';
import { codeExtensions, documentSymbols, languageIdForPath, languageSupportForPath, navigationTarget } from '../src/renderer/code-language.mjs';

test('code language mapping covers supported families and safely downgrades shell', () => {
  assert.equal(languageIdForPath('src/main.tsx'), 'tsx');
  assert.equal(languageIdForPath('tools/build.py'), 'python');
  assert.equal(languageIdForPath('scripts/run.sh'), null);
  assert.deepEqual(languageSupportForPath('scripts/run.sh'), []);
  assert.ok(codeExtensions('src/main.ts').length > 0);
  assert.deepEqual(codeExtensions('README.unknown'), []);
});

test('CodeMirror language support constructors are real offline extensions', () => {
  for (const path of ['a.js', 'a.py', 'a.json', 'a.css', 'a.html', 'a.sql', 'a.java', 'a.cpp', 'a.go', 'a.rs']) {
    assert.ok(languageSupportForPath(path), path);
  }
});

test('current-file symbols and definitions are discoverable without changing text', () => {
  const text = 'const answer = 42;\nfunction greet(name) { return name; }\ngreet(answer);';
  const symbols = documentSymbols(text);
  assert.deepEqual(symbols.map(item => item.name), ['answer', 'greet']);
  const target = navigationTarget(text, text.lastIndexOf('greet'));
  assert.equal(target.kind, 'definition');
  assert.equal(target.name, 'greet');
  assert.equal(text.slice(target.from, target.to), 'greet');
});

test('navigation preserves import targets for host boundary checks', () => {
  const target = navigationTarget('import value from "../../outside";\nvalue();', 7);
  assert.equal(target.kind, 'path');
  assert.equal(target.path, '../../outside');
  assert.equal(navigationTarget('const value = 1;\nvalue();', 20).kind, 'definition');
});
