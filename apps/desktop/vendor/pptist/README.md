# PPTist embedded engine

Upstream: https://github.com/pipipi-pikachu/PPTist
Revision: `82ecf10040ca8da67832f173b58d3baf5da59887` (2.0.0)
License: AGPL-3.0, see LICENSE.

Reproduce from a clean desktop directory with `node tools/build-pptist.mjs`, then `npm run build:renderer`. The build requires Git, tar, Node.js/npm and network access to GitHub and the npm registry; no pre-existing local upstream copy is used. It fetches only the pinned revision into a fresh, exclusively owned `.test-output/pptist-build-*` directory, creates an uncompressed `git archive --format=tar`, and checks SHA-256 `f23dfaf45708a1cf04cabaa08077a16e00c2b5244e76d6821df56265a1c67c81` before extracting or applying changes. This digest was obtained from a fresh GitHub fetch of the pinned commit, not from a network-generated tarball. A checksum mismatch stops the build. The temporary directory is removed on success or failure.

`dist/` is the locally built browser engine, with the Nozeli bridge and export changes defined in `../../tools/build-pptist.mjs`. The build also writes `upstream.tar.gz` from the verified, unmodified Git archive (including its package lock) for corresponding-source distribution; it is a generated output, not an input. No runtime Git, Node package installation, shell or document service is required. The resulting assets are platform-independent, but only Linux runtime is tested.

Changes: expose import/export/store and history initialization to the parent adapter; establish a current-file undo baseline after import/draft restore and flush pending native snapshots before undo/redo; route clipboard reads through the host bridge and reject a stale object/slide target; return generated PPTX blobs to Nozeli instead of direct browser downloads; hide upstream header (alternate file/cloud controls). Host CSP blocks remote font/API/media loading. Source and full license are retained for corresponding-source compliance; release-wide license review remains required before distribution.

PPTX model edits use versioned, source-digest-scoped drafts in the Nozeli userData directory. PPTX export exclusively creates a new file, never overwrites originals or other files. Native presentation fidelity remains limited; Nozeli annotations are not yet attached to PPTist objects. Legacy `.ppt` is not supported.
