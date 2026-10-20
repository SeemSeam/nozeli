// Build before the real Electron suite; usable by the root regression runner.
await import('./build-renderer.mjs');
await import('../tests/desktop-electron.test.mjs');
