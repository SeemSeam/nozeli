# Basic Memory isolated evaluation notes

Final parent verification: `runs/final-validated/report.json` is completed for 10/100/1000, with no blocked network/model attempts. Stable reads/source bytes, external edit/rename/delete plus explicit reindex, rebuild and >5 pagination succeeded; current recall is query-dependent and the long natural query missed. This is a completed lexical experiment, not production approval. Earlier worker-only/pending statements below describe authoring history; final results and scope take precedence. See [full report](../../../docs/long-term-memory-evaluation.md) and `../comparison.json`. Empty stemmer license metadata was resolved to its included MIT license in `evidence/license-resolution.json`.

## Reproduction and parent-owned final run

Installed **the actual `basic-memory==1.0.0` distribution**, not a reimplementation. The initial uv setup inherited a harness interpreter-install location even though HOME was isolated; the parent's failure traceback exposed that location. The exact Python 3.12.13 interpreter tree has now been copied unchanged into `basic-memory/home/.local/share/uv/python/`, and the venv interpreter link and `pyvenv.cfg` point there (`evidence/interpreter-relocation.json`). Reproduction setup explicitly sets UV_PYTHON_INSTALL_DIR to this isolated home. Venv, download cache, home/config, model caches and experimental projects are confined to `basic-memory/`; no runtime CCB dependency is intended. No production data, credentials, paid services, daily install, commits or pushes are used.

From the repository checkout root:

```sh
python3 evaluation/long-term-memory-20261107/basic-memory/setup.py
python3 evaluation/long-term-memory-20261107/basic-memory/run.py --output "$PWD/evaluation/long-term-memory-20261107/basic-memory/runs/new-independent-run"
```

The first command is **reproduction setup, not needed again for the already-installed environment**. It uses `requirements.lock` (all 159 installed distributions pinned), retains installation logs/timings and refreshes dependency/license inventory. It may use the network for public Python/packages. The experiment command reexecutes this directory's Python, strips inherited environment/credentials, sets a new isolated HOME, loads the evaluation tripwire, and refuses output outside a **new** `basic-memory/runs/` child. If `runs/final` exists, select a different new name; never reuse/delete someone else's results. Defaults are sizes **10, 100, 1000**, reading **`../corpus.json` and `../oracle.json` at runtime**. Corpus SHA-256 and oracle SHA-256 are recorded in `report.json`. No earlier corpus was imported during authoring.

Final experiment has deliberately **not been run by this worker**; parent owns the single final execution. No build/lint/tests/formatters/smoke runs were run. Installation/setup probes only: Python/uv versions; successful pinned installation; CLI help for search/read/project/reindex/reset/MCP; installed tool manuals; dependency metadata without candidate imports; public release/doc/wheel retrieval. Initial setup wall-time was not instrumented (explicitly null in `evidence/setup-actual.json`); no invented install-time figure. Reproduction setup captures command wall-time.

### Parent-run failure preserved and correction

The parent executed `runs/final/`: all three search-only indexing invocations succeeded, but every MCP connection closed before retrieval. This failure is preserved unchanged. `n10/raw/mcp.stderr:114-159` traces startup through FastMCP `run_stdio_async` → `log_server_banner` → `check_for_newer_version` → PyPI fetch; the guard blocked DNS to `pypi.org`. Disabling Basic Memory's `auto_update` did not disable **FastMCP's separate banner version check**. This is observed evidence against claiming the initial configuration starts fully offline.

Installed FastMCP 4.1.3 has an explicit supported setting: `settings.py:336-349` documents `FASTMCP_CHECK_FOR_UPDATES=off`; `utilities/version_check.py:140-142` returns before any fetch when set. The corrected driver sets that variable, retaining banner, guard, candidate server and actual retrieval unchanged. Exact dependency source is copied under `evidence/source/fastmcp/`. This is configuration of the real dependency, not exception suppression or a replacement MCP implementation. No corrected experiment or smoke test was run by this worker.

Corrected parent command (new output; preserve the original failure):

```sh
python3 evaluation/long-term-memory-20261107/basic-memory/run.py --output "$PWD/evaluation/long-term-memory-20261107/basic-memory/runs/final-offline-config"
```

Each size and aggregate report now includes `status: completed|blocked` plus infrastructure diagnostics. CLI nonzero exits, tool invocation exceptions/errors (excluding expected missing read after deletion), or malformed search/pagination responses mark the experiment blocked. The driver exits **2** on blocked execution, **0** for completed observations. A genuine empty result, oracle mismatch, low recall, unsupported observed identity behavior or rebuild mismatch remains an observation, not an infrastructure exit failure. Corrected startup remains unverified until the parent runs it.


## What the runnable driver actually exercises

- Real `basic-memory project add --no-wait --local`, followed by **`reindex --search --full`**. `--no-wait` avoids the normal project-add path's automatic embedding phase. Installed source `cli/commands/db.py` explicitly passes `embeddings=False` in the search-only path.
- Real persistent **stdio MCP server**, driven by the installed FastMCP client. Runtime tool schemas are saved. Warm query latency is MCP client/server/API/SQLite roundtrip, **not bare FTS engine time**. CLI registration/index/rebuild times are cold subprocess timings; MCP startup is measured separately. Do not compare cold CLI time with another embedded engine as an engine-speed ratio.
- All seven independent-oracle queries: `双星`, `混沌`, `雙星`, `binary chaos`, `目前双星混沌应当采用哪一种积分方法`, `finishClosure`, `src/agents/managed/controller.mjs`.
- Every returned ID on all native 100-item pages (bounded safety limit 30 pages, reported if exceeded). Raw pages retained. Separate native 5-item page 1/page 2 test explicitly reports whether results beyond five are reachable. No slicing an already-limited five-result preview.
- Exact oracle expected/actual/missing/unexpected IDs, precision and recall for raw history, **host-filtered effective current**, and **explicit native frontmatter-filtered current**. Empty returned sets have precision null, not fabricated 100% precision.
- Reads **every input stable permalink** `kNNNN` with real `bm_read`, saves each raw response, checks complete original Markdown and the exact canonical JSON source row (all provenance fields, source digest/span included). Source JSON is a preserved record, not inferred facts. `import-map.json` records source JSON and generated Markdown hash per ID.
- External file edit, external rename keeping pinned permalink, explicit incremental reindex, stable read after edit/rename, marker search, external deletion and explicit reindex, missing read/search. MCP is stopped before each external reconciliation: **this does not measure the realtime watcher**.
- Restores original source file, then invokes real `reset --force` with explicit confirmation **only inside this newly created isolated run**, followed by full search-only reindex. Verifies exact rebuilt ID set and stable full read. This genuinely discards the generated candidate index, not just an incremental refresh described as rebuild. MCP is disconnected before reset.
- Separate host-authored latest-report-per-Work/revision grouping and older Work report IDs. This is **not knowledge supersession**: each corpus ID is a distinct stable knowledge row, and multiple IDs from one Work can remain current.

### Current/history meaning

The independent parent oracle controls relevance; no driver-normalization oracle or synthetic semantic extraction. History expectations are intersected with the size prefix. Current knowledge means project `alpha`, instance `i1`, status `confirmed` or `verified`, not tombstoned. **`outcome=accept/discard/failed/unconfirmed` is not a truth/approval gate.** No latest-Work-revision gate is used for knowledge currentness. Native Basic Memory text search does not implement this Nozeli policy by default. The explicit native-filter path tests ordinary imported metadata filtering; host-effective output is plainly labelled an adapter, not a passed native capability. Raw scope/status leaks remain visible as unexpected IDs.

Representation is transparent: one Markdown note per corpus ID, pinned `permalink: kNNNN`; corpus title/text plus exact JSON source record in its body; frontmatter exposes knowledge ID, project/instance, status, outcome, Work/revision. Source JSON and metadata are searchable too. No manual aliases, CJK tokenizer rewrite, replacement index, synonym expansion or reranking is injected.

## Resource/output definitions

`runs/<name>/report.json` and each `n<size>/summary.json` contain results. `raw/` contains every CLI stdout/stderr, arguments/exit status, MCP tool call response and measured latency. `process-tree.jsonl` samples driver plus recursive live descendants (candidate CLI/MCP processes) every 50ms, including PID/PPID/create-time/command, RSS and user+system CPU. Peak RSS is **peak sum of sampled tree RSS**, not kernel high-water RSS; shared pages may double count and very short processes can be missed. CPU is last-seen cumulative user+system for each PID/create-time, minus the driver's initial CPU for that size. It is total CPU seconds, not peak percentage. Measurements are on a shared machine; parent has `../machine.txt`.

Data paths are saved explicitly. `state/` DB/config/log footprint, `notes/` source footprint, `cache/` runtime cache and `raw/` diagnostics are reported separately, both logical and allocated bytes. Dependencies (`.venv/`), setup uv cache (`cache/`) and downloaded interpreter/setup home (`home/`) are distinct install footprints, never counted as the candidate source-data size. Final filesystem measurements include generated WAL/state/log files still present, not just a chosen SQLite main-file size.

## Zero-model boundary

The tested mode is **keyword/text-only**, not semantic embeddings or extraction. Search and rebuild explicitly request text-only. Reranking, automatic updates, cloud promos/telemetry and file watching are disabled; initialization sync is skipped and indexing is explicit. No API keys are inherited. Empty isolated FastEmbed/HuggingFace caches and offline settings are used.

`guard/sitecustomize.py` is evaluation-only fail-closed instrumentation, **not a candidate retrieval replacement**: external IPv4/IPv6 socket connections and DNS raise, as do FastEmbed/ONNX model constructors. `guard.jsonl` records guard loading and every prohibited attempt. Any blocked operation becomes a real candidate error and is retained; there is no fallback search implementation. Reports label the basis for zero completed model calls. A blocked attempt must not be relabelled a successful supported semantic capability. No claim about zero-cost production semantic extraction is made.

## Official provenance, license, domain, release and sync

Retained sources and URLs:

| Evidence | Official URL | Local evidence |
|---|---|---|
| Public package metadata / dependencies / wheel digest | https://pypi.org/pypi/basic-memory/json | `evidence/pypi.json` |
| Pinned release | https://github.com/basicmachines-co/basic-memory/releases/tag/v1.0.0 | `evidence/release.json` (GitHub API response) |
| Pinned license | https://raw.githubusercontent.com/basicmachines-co/basic-memory/v1.0.0/LICENSE | `evidence/LICENSE` |
| Pinned README, official docs/domain links and local/cloud distinction | https://raw.githubusercontent.com/basicmachines-co/basic-memory/v1.0.0/README.md | `evidence/README-v1.0.0.md` |
| Official product site linked by canonical README | https://basicmemory.com | `evidence/domain.html` |
| Knowledge/file format | https://docs.basicmemory.com/concepts/knowledge-format | `evidence/knowledge-format.html` |
| CLI reference | https://docs.basicmemory.com/reference/cli-reference | `evidence/cli-reference.html` |

Release **v1.0.0** published **2026-10-29T23:45:31Z**. PyPI wheel uploaded **2026-10-29T23:45:53.690996Z**. Retained wheel `basic_memory-1.0.0-py3-none-any.whl` SHA-256 **`a2d2c1589616c9599aec9edd6597d508028c5af88632312fc0990dcaccf02867`**, fetched and digest compared with PyPI metadata during setup.

PyPI declares **AGPL-3.0-or-later**; pinned upstream LICENSE contains GNU AGPL v3 terms. This is not legal clearance or by itself a rejection of an AGPL Nozeli product. **`evidence/installed-distributions.json` lists all 159 installed distribution names/versions, License-Expression, License metadata text, license classifiers/files, unknown flag, and direct Requires-Dist entries** without importing candidate code. One distribution has no useful license metadata and is explicitly unknown; metadata is not a complete legal/source redistribution audit. `requirements.lock` is the exact installed dependency inventory; `evidence/collect-distributions.py` reproduces metadata collection.

Local-first Markdown plus a local SQLite index is the evaluated storage boundary. The official domain linkage is from canonical upstream metadata/README, **not an independent domain ownership/security audit**. Installed pinned `cloud/removed_mirror_commands.py` says old `cloud sync`/`bisync` are removed in 1.0, with **`cloud pull` / `cloud push`** guidance; copied under `evidence/source/`. Do not rely on older marketing README's rclone/bisync claim as the v1.0 CLI contract. Local filesystem index reconciliation is executable here; cross-device/cloud push/pull/conflict handling is official documented functionality but **not exercised** (no account/credentials/network experiment). Paid cloud is not a dependency.

Installed manuals are retained (`bm-search-manual.log`, `bm-read-manual.log`) and explicitly distinguish local reads from **cloud-only stored versions/history**. Keeping separate source revision notes is archival caller data, not native local immutable version history.

## Unsupported/unverified and production gaps

- Windows/macOS **unverified**; only this Linux environment was installed/probed. No cross-platform startup/RSS or packaging pass claim.
- No semantic extraction/embedding/reranking quality/cost assessment; natural Chinese query is a real text query and may correctly expose a miss.
- No native Nozeli project/instance authorization, approval/truth semantics, tombstone policy, immutable evidence identity, transactional outbox/recovery or production adapter/cutover is implemented by this experiment.
- Default text search is not host-effective current knowledge; native metadata filters require caller-provided fields and policy. Work grouping is not automatic conflict resolution.
- Stored historical versions advertised in cloud manual are not proven for local mode; separate imported revisions are not native version retention.
- No realtime auto-watch latency, cloud account/sync, external service, real user data, model download or production workload tested.
- Parent final run is now complete in `runs/final-validated/report.json`; consult exact oracle missing/unexpected IDs and measured metrics there. Unsupported production/platform/model boundaries above remain unchanged.
