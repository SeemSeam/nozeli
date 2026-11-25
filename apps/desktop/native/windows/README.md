# W1 Windows file primitives experiment

The explicit single cold handoff accepts the original tagged ColdAnchor plus
its retained metadata parent. It validates file identity, parent membership,
private ACLs and the complete database/source bundle, then duplicates the
original restricted file object into custody. It never reopens a writable
anchor or exports numeric HANDLEs to JavaScript. The warm path retains its
existing private writable file requirements. The shared in-process anchor tag
does not change supervisor v9 / launch-set v2 wire formats; both native addons
must be rebuilt together. This does not qualify repeated cold recovery or the
default managed entry point. See docs/windows-alpha6-cold-handoff.md.

This Node-API 8 component is not a production filesystem adapter. Shared selectors
and the capability matrix continue to report Windows safe-file-io unsupported.
The component owns the volume root, every ancestor, and the read file as HANDLEs.
Children are opened relative to the parent HANDLE with NtCreateFile, not by
concatenating paths. Reparse entries, non-NTFS/non-fixed volumes, UNC/device paths,
alternate streams, traversal and multiple hard links are rejected. Existing
sharing conflicts fail closed; there is no retry with weaker sharing.

Build with the pinned development Node 22.23.4, installed locked npm dependencies,
Python and Visual Studio 2022 C++ Build Tools / Windows SDK:

```text
npm run build:windows-native --prefix apps/desktop
npm run test:windows-native --prefix apps/desktop
```

The output is ignored under `native/windows/build/`. This explicit suite is
separate from the default unit/integration suites because it requires a locally
built native experiment. A missing build fails its preflight; it is not skipped.
The command runs the same explicit read and write test files against the same compiled Node-API binary
with pinned development Node and locked Electron in its Node mode
(`ELECTRON_RUN_AS_NODE=1`). The driver waits for the actual child processes and
requires nonempty TAP summaries with no failures or skips in both hosts.
Run the suite as a standard user. Windows can assign the token's default owner
(for example, `BUILTIN\Administrators`) to an ordinary file even when it
inherits a sole-user DACL. Such files, including SQLite sidecars and private
tree members, do not meet Nozeli's owner check and are rejected. The hosted
Windows job runs both hosts under a disposable standard account; it does not
relax that check or repair descriptors. The driver uses the resolved temporary
directory for both hosts so a temporary-directory alias does not change the
scope when project registration resolves the fixture path.
Per-host logs, runtime facts, binary SHA-256 and a validation receipt are saved
under `.test-output/ci/windows-native-hosts/`, or `NOZELI_TEST_EVIDENCE_ROOT` when
set. Compilation does not prove either host runs.
The explicit build leaves the existing desktop postinstall unchanged while this
component is under qualification.

`openExperimentalAnchoredRead(root, relative)` returns `read(chunkSize)`,
`identity()`, `verify()` and idempotent `close()`. Chunk sizes are bounded to 1 MiB;
reads are synchronous and sequential. Explicit close releases all handles; a
Node-API finalizer provides fallback cleanup. Handles cannot be used as arbitrary
numeric process handles or transferred to unrelated receivers. Ancestor handles
deny write/delete sharing, so the experiment may reject directories already
opened for those accesses. This is intentionally conservative.

`openExperimentalWriteParent(root, relative)` pins the directory chain and may
create missing relative directories; the root must exist. It returns
`createExclusive(name)`, `createPrivateExclusive(name)`,
`createPrivateDirectory(name)` and idempotent `close()`. A stage owns its newly created
file HANDLE and retains its directory pins even after the parent wrapper closes.
Its operations are:

- `write(bytes)`: sequential, synchronous writes from a non-shared `Uint8Array`
  (including `Buffer`), at most 1 MiB per chunk.
- `sync()`: flush file bytes. Every subsequent write requires another flush.
- `publishNew(name)`: a handle-relative NT rename with replacement disabled.
  Existing targets cause refusal, including case-equivalent names on the tested
  insensitive directory. A successful result reports
  `{published:true, durability:'namespace-not-qualified'}`.
- `verify()`: check directory identities and the owned file identity/link count.
- `close()`: discard an unpublished stage using its own HANDLE; retain a published
  file. Finalizers provide best-effort cleanup, leaving an orphan if native
  deletion fails. Cleanup never reopens/unlinks a mutable filename.

Publication makes the stage immutable through this API. Post-publication errors
carry `committed:true` and `durability:'uncertain'`; cleanup retains that file.
The Node-API export binary retains its experimental `nozeli_windows_read.node`
name and contains read, staging and experimental transaction entrypoints.

`openExperimentalReplacement(root, relative, expectedSha256)` compares the locked
target bytes before returning a TxF transaction with `read()`,
`prepare(bytes, exclusiveStageName)`, `commit()` and idempotent `close()`.
Preparation remains invisible to ordinary readers. Closing rolls back; committing
returns `{committed:true,durability:'namespace-not-qualified'}`. Read and candidate
sizes for these legacy whole-body methods are each limited to 1 MiB. The
streaming methods below remove that whole-body limit. The transaction times out
after 30 seconds.
Callers must save recovery drafts separately before starting the transaction:
transactional staging is discarded on rollback or process termination.

KTM loads from System32 only; unavailable APIs/transactions fail explicitly with
no ordinary-rename fallback. Microsoft recommends alternatives to TxF and warns
it may be unavailable in future Windows. This experiment is not an unconditional
Windows product dependency. Parent pins prevent ancestor replacement while TxF
uses handle-derived extended paths. Tests cover competing writes, rename, delete,
hard links and transactions, stale digests, rollback, live GC, natural/forced exit,
long Unicode paths and real timeout/aborted commit in both hosts.

Commit failures expose `transactionOutcome` as `committed`, `aborted` or `unknown`;
known committed failures also carry `committed:true,durability:'uncertain'`.
Never automatically replay an unknown outcome. The committed-error and unknown
branches still require fault injection. The new file inherits its parent ACL;
target owner/group/DACL policies are copied at candidate creation and verified
before writing. Uninspectable/null DACLs and policies that cannot be reproduced
are refused before publication. ACL comparison includes owner, group, protection
and each ACE; Windows may normalize auto-inherited bookkeeping. SACL, integrity
labels and other file metadata are not preserved by this experiment.

Private creation uses the process user SID from the actual token and supplies a
protected single-user full-control DACL to NtCreateFile atomically. Private
directories propagate that ACE to children. There is no create-then-chmod window,
arbitrary SID input, token privilege adjustment or recursive ACL repair. Existing
names are refused without changing their bytes or permissions. Impersonated
threads are explicitly unqualified. Private stages verify owner/group/DACL during
write, flush, verify and publication; detected policy changes stop further work.
This is a permission policy, not a sandbox against the owner or privileged users.
Ordinary sharing does not block a same-user WRITE_DAC operation. The tested TxF
target refuses independent path-based ACL writes both before and after prepare;
pre-opened security handles, hostile stress and final-check races remain pending.

Remaining W1 work includes moving synchronous native I/O off the UI thread,
writable mappings and hostile stress tests, production
CAS/draft integration and TxF availability policy, private metadata/SQLite/credential
consumer integration and extended security metadata, path aliases, directory namespace persistence, full Git/provisioning consumers,
multi-step transactions and fault recovery. No durability, power-loss, complete
filesystem safety or product-readiness claim follows from component tests.

The current design, remaining decisions and qualification evidence are recorded
in [the Windows filesystem design](../../../../docs/windows-filesystem-design.md).

`openExperimentalPersistenceParent(root, relative)` opens an existing parent
with explicit `GENERIC_READ | GENERIC_WRITE` access for `syncDirectory()`. All
ancestors are pinned and checked. The final directory allows read/write sharing
so native rename can run, but denies delete sharing; ordinary read/write-parent
entrypoints retain their previous sharing/access policy. Missing directories
are refused without creation, as are volume-root flushes, reparse chains and
unsupported volumes. No volume-wide admin flush or path reopen is attempted.
Ordinary parents reject `syncDirectory()` because their handles lack flush rights.

`createExperimentalWindowsPersistence(root).writeAtomic(relative, bytes,
{expectedSha256})` runs private staging + file flush + create-only publication,
or locked-digest TxF replacement, followed by the same pinned parent's flush.
Omit the digest only for a new file; existing targets are never unconditionally
overwritten. Missing parents are not provisioned by this entrypoint. Errors after
publication carry `committed:true,durability:'uncertain'` and retain published
content; cleanup errors are attached without replacing the primary outcome.
The explicit directorySync callback is a qualification fault-injection boundary.

Success reports `state:'barriers-completed',durability:'namespace-not-qualified'`
with file/directory flush facts, and the adapter exposes `supported:false`.
It is not selected by shared persistence and cannot stand in for its `durable`
receipt. Metadata single-writer/version semantics, standalone directory sync,
delete/move/mkdir barriers, hardware/cache qualification, hostile shared-write
directory races and full consumers still need verification.

The read pin also exposes `stat()` (initial HANDLE-derived size/link count/file
attributes) and `readAt(offset, size)` (safe integer offset, <=1 MiB chunk).
Each seek/read call is synchronous; independent JS streams supply independent
absolute cursors. No worker or external code receives this HANDLE.
`experimentalWindowsReadFilesystem` adapts it to the shared reader via explicit
injection. Streams restart at zero, use 256 KiB chunks and support backpressure
and destruction between chunks. Only missing-entry errors 2/3 become null;
permission, sharing, entry and reparse failures propagate. It does not fabricate
POSIX inode identities. Windows file mode maps to regular `100644`; preserving
tracked executable modes remains a separate Git policy gap.

Shared `blobFiles`/`blobFile` accept an optional filesystem adapter. Linux keeps
its declared fd-path batch. Adapters without fd paths send pinned byte streams
to `git hash-object --stdin`, compare the independently computed Git OID and
verify the pin before returning. They never reopen a DOS source path. Existing
known-object optimization remains; changed files currently cost one Git process
per file. The explicit Windows reader remains `supported:false`, refuses writes
and is absent from production selectors. Partial reader/Git qualification does
not qualify the full Work lifecycle, acceptance, rollback or persistence.

`ExecutionWorkspace` forwards its filesystem injection to snapshot, initial
capture, legacy import and reconciled-blob call sites. The snapshot capture
method has two real-host tests: changed/staged/new/deleted/excluded inputs with
an independent Git tree/commit, and refusal/cleanup with original refs, user
index and disk content retained. The full component suite is 70 tests, passing
in source and extracted Node/Electron hosts. Other call sites are wired but
their complete workflows remain unqualified. No Work preparation, provisioning,
acceptance, rollback, ledger or production capability is enabled by this change.

Streaming replacement adds `readChunk(offset,size)`, `beginCandidate(name)`,
`writeCandidate(bytes)` and `finishCandidate()`. Native chunks are <=1 MiB,
and JS uses 256 KiB chunks with event-loop yields and abort checks. The target
remains locked from base hashing through candidate flush/prepare and commit.
The transaction owns both target and candidate HANDLEs; close/finalization/host
exit closes candidate before rollback. Legacy `prepare()` refuses an open
streaming candidate. Candidate owner/group/DACL and link identity are checked
on writes and before preparation.

`writeStream(relative, source, {expectedSha256,expectedNewSha256,signal})` composes
this sequence or private create-only staging, verifies the candidate digest
before publication, then flushes the same retained parent. The source is an
iterable of non-shared byte chunks. A producer that has not yet been consumed
remains caller-owned. Abort checks and JS yields operate between chunks; they
cannot interrupt a stalled producer or blocked native syscall. A 33 MiB base
and candidate are verified without whole-body transaction buffers. The small
`writeAtomic` convenience still limits its supplied bytes to 1 MiB.

`experimentalWindowsVersionedFilesystem` supplies explicit optional
`writeVersioned`, `writeVersionedStream` and `removeVersioned` operations alongside reads. Writes require an approved candidate
digest and remains `supported:false`; generic parent/rename/remove/chain methods
still refuse. Shared `applyReviewedFiles` preflights the entire plan, uses this
operation when explicitly declared, maps stale-base conflicts to WORKTREE_DRIFT
and retains committed/uncertain facts on postpublication failures. Its existing
non-versioned branch stays available to the declared Linux adapter.

Managed writes conservatively refuse metadata/credential case equivalents,
normalization equivalents, all tilde components and DOS reserved names, without
rewriting the native path. This intentionally refuses some ordinary names; it
does not qualify general 8.3 aliases or case-sensitive directories. The review-write slice's
suite is 84 tests, passing in source and extracted Node/Electron, including
independent races, producer/abort/mismatch rollback, live-candidate host exit,
whole-plan drift/path refusal, ACL policy preservation and committed uncertainty.
If a later file conflicts after an earlier publication, the error includes
`appliedFiles` and committed/uncertain facts. The earlier file and independent
winner remain; the group is not an atomic transaction and is never auto-replayed.
Full acceptance/rollback, Work preparation/recovery, metadata ledger, generic
namespace operations and production durability remain pending.

The subsequent deletion/install slice adds `prepareDelete()` on the same
inspected transacted target HANDLE. It sets disposition without reopening a
path or repairing readonly attributes, closes the target, then uses the same
explicit commit/rollback lifecycle. `removeVersioned` hashes the locked base,
requires its SHA-256 and flushes the retained parent after commit. Deletion
receipts claim a directory barrier only. Closed-parent faults preserve
`committed:true` and `durability:'uncertain'` after the deletion.

`ExecutionWorkspace.installFile` uses optional versioned operations for forward
and reverse file installation, with lazy bounded `blobStream` transport from
the actual bundled Git. Git is started only when consumed; early termination
destroys the pipe and awaits the producer's cleanup, and stdout completion
alone cannot hide a late Git failure. SHA-1 and SHA-256 IDs are supported.
Postpublication verification errors identify `relPath` and retain committed
uncertainty. Independent winners are retained in either direction. Requested
Git modes other than `100644` and missing parent directories are refused.

The delete/install slice's complete suite has 101 tests (17 new cases), passing
in source and extracted Node/Electron hosts with no skips. It includes actual
33 MiB Git install/reverse, changed/new/deleted Unicode files, index/ref/draft
preservation, native deletion locks/rollback/host exit, races, cancellation,
corrupt objects and real closed-parent failure. These qualify individual
methods by explicit injection. Full acceptance/index/ref/ledger recovery,
whole-group rollback, generic directory operations, asynchronous native I/O
and production durability remain pending; selectors remain disabled.

The private SQLite slice adds `openPrivateDatabase(name,mustExist)` on a pinned
existing persistence parent. It requires a protected current-user-only parent,
creates a new main file with that policy, retains its same single-link HANDLE
and returns a path resolved from the retained directory. Data-read access with
read/write sharing denies rename/delete while remaining compatible with the
real SQLite Windows VFS. An attribute-only first attempt failed delete denial;
the corrected access mask passes actual independent rename/delete tests.
The lease checks parent/main security and existing journal/WAL/SHM entries for
single-link, non-reparse, sole-user FullControl policy. SQLite-created files
may inherit that single ACE. It never repairs existing permissions.

`StorageDatabase({experimentalWindowsRoot})` explicitly sends the root to the
existing storage worker; production defaults do not request a lease. SQLite
retains DELETE journal mode, FULL synchronous mode, schema checks, receipts,
revisions and collection CAS. The worker holds namespace pins until SQLite
actually closes or the worker exits. Integrity loss after a possible commit
reports STORAGE_RESULT_UNKNOWN; the parent fences all admitted operations,
joins the old generation and requires explicit receipt reconciliation.

Twelve new native/shared SQLite cases bring the complete component to 113,
passing in source and extracted Node/Electron. They include actual abrupt
transaction exit with a hot journal and recovery of original data, a real
exclusive-lock timeout, independent recovery drafts, unsafe-entry refusals,
original schema bytes and actual worker-exit pin release. Shared worker safety
has 27 selected passes; the full file's 27 passes/7 failures remain recorded
(six require disabled project initialization, one assumes unlinking an open
database). Controlled-worker tests cover unknown-reply fencing, not native
postcommit fault injection. Existing private parents only; hostile sidecar or
security races, WAL, power-loss/namespace durability, project initialization
and complete Work ledger/acceptance recovery remain unqualified.

Private directory trees now use `anchored-directory.inc` and
`ensureExperimentalPrivateDirectory(root, absoluteDirectory)`. Each child opens
relative to its pinned parent, carries protected current-user-only permissions,
and retains the entire ancestor identity/security chain after earlier JS leases
close. Existing broad directories are refused without permission repair. The
complete path plan is checked before effects, with at most 128 components.
Each edge flushes child and parent; partial failures retain actual created IDs
and report committed/uncertain rather than removing names.

`ProjectStorage(profile, {experimentalWindowsRoot})` explicitly uses this entry
for `ready()`, `localDirectory()` and `recoveryDirectory()`, with the existing
SQLite worker and shared lifecycle state. Twelve additional tests bring the
directory-tree slice to 125, passing in source/extracted Node/Electron with
zero skips. They cover cold catalog/lifecycle reopen, offline local/recovery
values, two independent provisioning processes, ancestor/ACL conflicts,
cancellation and a real closed-handle barrier fault. The offline test explicitly
seeds a synthetic catalog binding; it does not qualify registration.

Historical tree evidence: `W1/build-windows-native-directories.json`,
`W1/directories-hosts-final/native-filesystem-hosts-validation.json` and
`W1/directories-component-roundtrip-final/component-roundtrip.json` under the
dedicated evidence root. That build's SHA-256:
`75371265c79009cf29965bb9fba71707a4fc820de40c1b00a15571c684c97ca0`.
The prior 113-case SQLite build is historical. Results remain
barriers-completed / namespace-not-qualified. Project initialization still
refuses before project effects; directory rename/remove/copy, recovery object
storage, hostile security races and complete Work recovery remain unqualified.

`anchored-directory-move.inc` adds
`parent.beginPrivateDirectoryMove(sourceName, destinationParent, destinationName,
expectedIdentity)`. It opens the private source with DELETE access and without
delete sharing, checks the mandatory volume/128-bit ID, retains both parents
and snapshots source/parent owner, group and DACL. `commit()` renames that exact
directory HANDLE relative to the destination parent with replacement disabled.
Closing the move lease, including on host exit, never removes either directory.
Existing targets and identity/security conflicts remain intact.

`moveExperimentalPrivateDirectory(root, source, destination, options)` validates
both entire plans, flushes the source directory before commit and the moved
directory plus both parents afterward. Cancellation only stops before commit;
postpublication failures carry source/destination/ID facts and committed/uncertain.
This pins the directory root; it does not validate, freeze or flush descendants.
Callers must quiesce writers and validate/sync tree contents separately.

Fourteen real-host move cases brought that slice to 139 per host in source
and extracted Node/Electron, with zero failures/skips. They include actual
SQLite draft/receipt reopening at a new parent, independent late winners and
competing publishers, ACL changes, real barrier-handle closure, cancellation and
host exit before/after commit. The first 13/14 run retained a fixture failure:
the exclusive move lease must close before reopening its source with an
incompatible share mode. The corrected test retains that denial.
Historical move SHA-256:
`b4f7159b8eaca77638b22ebf688ff7896f45da008588aba111322f5b3c7d4af5`.
Evidence: `W1/build-windows-native-directory-move.json`,
`W1/directory-move-hosts-final/native-filesystem-hosts-validation.json` and
`W1/directory-move-component-roundtrip-final/component-roundtrip.json`.
Local NTFS/existing parents only. Directory copy/removal, project registration,
native unknown rename faults, hostile races, namespace/power-loss durability
and complete Work recovery remain unqualified; production selectors stay off.

`anchored-private-tree.inc` and `openExperimentalPrivateTree(root, directory,
options)` now provide relative HANDLE enumeration, private single-link file
pins, and an immutable manifest of names, File IDs, content/ACL SHA-256 and
byte counts. Each file pin requests read/write access for actual flushes and
denies other data writers and namespace changes. Strict private directory
ACLs and sole-user file ACLs are checked without repair. `readFile()` defaults
to 1 MiB; `streamFile()` yields at most 256 KiB. Capture is bounded to 10000
descendants and defaults to 1 GiB of file bytes; exceeding limits refuses.

`verify()` rechecks directory membership, identity, ACL and content.
`sync()` flushes files, directories in postorder, and the pinned parent, then
rechecks. `publishTo(destination)` syncs first, retains the exact DELETE root
HANDLE, releases descendant pins, publishes without replacement, flushes the
root and both parents, then reopens/rechecks the entire original manifest.
Actual NTFS returned access denied (5) while strict descendants remained open;
the implementation preserves that sharing policy. Caller writer quiescence
is required. This release/recheck sequence does not atomically freeze a tree.
Data, member or ACL changes during the interval produce committed/uncertain
with root/manifest facts, keep the observed destination, and block replay.
An active reader blocks publication; cancellation before commit preserves the
source, and cancellation after commit does not skip completion barriers.

Twenty new real-host tests qualify 420-entry multipage enumeration, 33 MiB
streams/hashes, independent write/delete/ancestor-rename denial, actual SQLite
quiescence and cold receipts, same-user ACL/member/content drift, real closed
barrier handles, explicit retry, cancellation and host exit before/after move.
Historical manifest/publication slice: 159 per host, zero skips or
failures. SHA-256:
`eb7ba2a23f2e466db4069d1df684dd67b493f838be416dac980997813068b185`.
Evidence: `W1/build-windows-native-private-tree.json`,
`W1/private-tree-hosts-final/native-filesystem-hosts-validation.json`, and
`W1/private-tree-component-roundtrip-final/component-roundtrip.json`.
The initial native refusal and release experiment are retained in
`W1/private-tree-probe.log` and `W1/private-tree-release-probe.log`.
Readonly/broad/reparse/hardlink entries refuse. At that slice, copy/removal, product project
initialization, hostile mapped/security races, namespace/power-loss durability
and full Work recovery remain unqualified. Production selectors stay disabled.

`copyTo(destination)` now creates an exclusive private root and exclusive child
directories while retaining their original HANDLEs and IDs. It streams pinned
source bytes into exclusive private stages, compares each source digest, flushes
and publishes without replacement, reopens each file relative to its parent and
compares its published ID, then retains pins for full destination/content checks
and file/postorder directory/parent barriers. Source membership is checked before
creation and after copying. Source and target must be disjoint; every destination
path is validated before creation. Existing targets and late winners are retained.
Copy preserves structure and content; private ACLs and attributes are recreated,
not cloned as arbitrary metadata. Errors carry `privateTreeCopy.created` with
known relative paths/IDs and committed/uncertain after any creation. Only exact
unpublished stage HANDLEs are discarded; partial directories/files stay in place.

Deletion must be explicitly opened and approved against a previously retained
whole-tree manifest digest (which includes root/entry IDs, content and ACLs):

```js
const lease = await openExperimentalPrivateTree(root, directory, {deletion:true});
try {
  await lease.remove({expectedManifestSha256:approvedManifest.sha256});
} finally { lease.close(); }
```

Deletion leases request DELETE during the original relative capture; there is
no release/reopen-by-name interval before removal. After verification and sync,
each file is hashed and removed through the same HANDLE, followed by postorder
empty-directory removal and each affected parent flush. Unexpected members stop
progress; native directory disposition refuses nonempty roots. This is incremental,
not an atomic tree transaction. `privateTreeRemoval.removed` records exact IDs and
`rootRemoved` records observed completion. Cancellation/fault after progress keeps
committed/uncertain; all subsequent operations on that lease refuse. Cold reopen,
reconciliation and a newly approved manifest are required. Moving a tree also
requires reopen at its new path before copying or removal.

The private-tree test file now has 40 cases; complete source and extracted
Node/Electron runs each pass 179/179, without skips. Additional evidence covers
33 MiB/chunk cancellation, active readers, real SQLite backup/cold receipts,
independent winners, late members, actual closed parent/file faults, partial
removal/host exits, root completion faults and replay refusal. Single-character
file/directory targets exposed a native rename structure length defect: buffer
length must be at least sizeof(RenameInformation), including its alignment padding.
The initial five-failure run remains `W1/tree-mutation-first.tap`.

Historical copy/removal binary SHA-256:
`c2627855b77ef7c6416d3a8f25724d259ed3971d11d6d9d2c960f4594a72d2bd`.
Evidence: `W1/build-windows-native-tree-mutation.json`,
`W1/tree-mutation-hosts-final-v2/native-filesystem-hosts-validation.json` and
`W1/tree-mutation-component-roundtrip-final-v2/component-roundtrip.json`.
The ZIP is a component archive using the locked development Electron host;
it does not qualify the full application package. Private writable local NTFS,
existing parents and caller writer quiescence are still required. Hostile mapped
writes/security races, native unknown outcomes, namespace/power-loss durability,
production registration and full Work recovery remain unqualified.

Shared `ProjectStorage` now routes initialization file effects through
`main/project-storage-io.mjs`; the default continues to require verified
production persistence. A scoped experimental entry additionally requires
`experimentalWindowsInitialization:true` alongside `experimentalWindowsRoot`.
Root-only injection retains the previous offline/catalog qualification and
still refuses initialization. No UI startup path or platform selector enables
the new opt-in.

`openAnchoredDirectoryIdentity` opens existing directories with data-read and
READ_CONTROL access, share read/write but deny delete. It snapshots the actual
ACL without requiring private policy on the user project root. It cannot create
missing directories and has no directory-flush grant. Its data access actually
blocks independent rename while nested persistence/SQLite opens remain compatible.
Project/metadata identities use complete volume and 128-bit File ID strings,
avoiding Node's numeric inode truncation. The project pin spans initialization;
phase checks and final return verify its original policy and identity.

The same shared prepared/staging/staged/source-preserved/published/complete
state machine now qualifies fresh registration and reopening. Metadata and
candidate children keep protected user-only ACLs; the public root ACL is not
repaired. Manifest JSON reads retain the private file/parent through SQLite
identity checks. Candidate allocation is checkpointed with its exclusive ID
before the marker write. A partial/markerless candidate with proven allocation
is retained with its manifest; an explicit retry chooses a fresh candidate name.
No candidate cleanup deletes external additions. Unknown allocation/unsafe
contents refuse and retain the observed state.

A completed candidate's full identity/content/ACL manifest is persisted before
no-replace publication. Cold recovery at source-preserved or published validates
that exact tree, not just its JSON operation marker. A closed-parent failure
after rename reports committed/uncertain; the next explicit cold registration
reconciles the moved identity. `retry()` uses a real scoped SQLite probe and
the existing receipt reconciliation. Registration results/catalog records carry
barriers-completed / namespace-not-qualified, without claiming production durability.

22 new real-host scenarios cover fresh Unicode registration, project/local/
recovery drafts and operation receipts across reopen, all six checkpoint phases,
partial/markerless retention, winners, changed staged/published roots, real
closed-parent faults, actual host exit at allocation/publication, root ACL drift,
metadata ACL/hardlink refusal, scoped retry and a controlled unconfirmed-close
reply. That controlled reply is not native UNKNOWN fault injection. The first
probe exposed an incorrect assumption that public project ancestors must have
the private metadata ACL; child provisioning now uses the pinned project root
as its anchor. Test harness cleanup and inherited --input-type flags were also
corrected; their failed logs remain outside the repository.

Current source/extracted Node/Electron suite: 201/201 each, zero skips/failures.
Native SHA-256:
`09917c382f9e5cd47895baf7fbf0bc400735fc2b3f330afa233d6420926997cf`.
Evidence: `W1/build-windows-native-project-init.json`,
`W1/project-init-hosts-first/native-filesystem-hosts-validation.json`, and
`W1/project-init-component-roundtrip-first/component-roundtrip.json`.
Shared safety: 27 selected passes; the full current file still has 27 passes/
7 failures at default production initialization and open-database unlink assumptions.

All profile/project paths must be inside the same explicit test scope on local
NTFS. Foreign metadata really invokes recovery-source ownership selection and
refuses RECOVERY_OWNER_UNVERIFIED before creating an initialization intent.
Source copy/backup/cleanup file effects are connected to the shared phases but
their full Windows path remains unqualified pending W2 ownership; tests do not
replace that proof. MaterialStore, full Work, multistep transactions, hostile
mapping/security races, native unknown outcomes, namespace/power-loss durability,
real UI and W5 application packaging remain unqualified. Linux/macOS not run.

## Scoped immutable material objects (2026-11-02)

`parent.openPrivateObjectRead(name)` opens a single-link private file with read and READ_CONTROL access, sharing reads only. It retains the full File ID and private parent/file policy snapshots. Independent readers coexist; write, delete and ancestor namespace changes are denied. `sync()` and `remove()` reject this read-only lease. The existing writable/deletion tree leases retain their contracts.

`MaterialStore(directory, {experimentalWindowsRoot})` keeps shared hashing/CAS/limits over a file-effect adapter. Its native object directory lease retains the private policy across async streams. Exclusive stages copy mutable input chunks, flush the exact file, publish without replacement, validate the winner and flush the pinned directory. Native chunk size is 256 KiB with JS yields. ProjectStorage forwards the explicit scope to project/recovery object operations and promotion.

Material-store batch binary SHA-256: `fa279a98d2deae3aa7e16c3184d1a6c33566b5c8b794b0648415267b980aeed2`. Twenty-two new cases bring source/extracted Node/Electron to 223/223 per run, zero skips/failures. Evidence: `W1/material-hosts-final/`, `W1/material-component-roundtrip-final/`, `W1/build-windows-native-material.json`. Existing shared material/platform regression: 23 pass/15 skips; full worker safety: 27 pass/7 retained failures, selected 27 pass.

Failures after publication retain committed/uncertain plus digest/size/stage ID facts. Unpublished host-exit pending files remain untouched; there is no ownership-based GC yet. Existing corrupt winners are never repaired. Local NTFS/explicit scope only; native mapped/security races, namespace/power-loss, full Work recovery and application packaging remain unqualified. Production selectors are unchanged.

## Shared Work component slice (historical 244 cases, 2026-11-02)

Current binary SHA-256: `24c50e7a9acf52fd77328621c676dc71020efaf0287bc232e3ef55a9ad342eda`. Native lock mode opens an exact private, single-link read/write/DELETE lock below a public Git parent while retaining its actual ACL snapshot. It never repairs the parent policy. Save the full volume/128-bit allocation ID before releasing the exclusive publisher HANDLE; recovery requires both that ID and the token. Failed full lock reacquisition cannot authorize forward changes or rollback of a cold installed intent.

The platform effects layer supplies private manifest CAS, bounded evidence reads/exclusive streamed copies, native worker-directory identity and versioned index/ref publication. Shared preparation, report/SQLite receipt, authorization checks, accept/discard and recovery decisions remain in ExecutionWorkspace. Committed/unknown publication holds the candidate and locks for explicit cold reconciliation. Projects with no declared payload can truthfully report an empty dependency list; actual dependency/resource copying still refuses an unqualified adapter.

Twenty-one new real-host cases bring complete source/extracted Node/Electron runs to 244/244 each. Evidence: `W1/work-hosts-final-v2/`, `W1/work-component-roundtrip-final/`, `W1/build-windows-native-work.json`; shared gates 23 pass/15 skip, zero fail. The targeted cold-lock regression first failed and then passed; both logs are retained. Previous worker safety results are historical (27 selected pass; full file 27 pass/7 fail), not rerun this batch.

These are direct component calls using a minimal synthetic store and actual Git/SQLite, not Workspace.open/Controller/business decision ledger or worker owner/stop proof. Git worktree cleanup retains the shared Git remove operation after identity checks; hostile cleanup races are unqualified. Hooks, legacy migration, dependency payloads, extended Git layouts, 100755/missing parents, TxF policy, native unknown injection and namespace/power-loss remain unqualified. W1 stays unsupported and production selectors remain disabled; no UI or application-package qualification.

## WorkChanges/direct business component (current, 2026-11-02)

Native binary unchanged: `24c50e7a9acf52fd77328621c676dc71020efaf0287bc232e3ef55a9ad342eda`. Reuse the actual prior native build; `W1/build-windows-native-work-changes.json` records the unchanged native-source hashes and reference. No new C++ compilation is claimed. Twenty new cases bring complete source/extracted Node/Electron to 264/264 each, zero failures/skips. Evidence: `W1/work-changes-hosts-final/`, `W1/work-changes-component-roundtrip-final/`; shared gates 23 pass/15 skip. Historical storage-worker results were not rerun.

Scoped WorkChanges uses private JSON CAS, exclusive recorded repository allocation and full root File ID/policy pins around bundled Git commands and blob streams; no unrecorded/replaced-root adoption. Precreate protected Git directories. Preserve readonly pack attributes: Git runs with core.fsync=all, while a native readonly tree verifies IDs/bytes/ACL and flushes directories only. The local intent states `files=not-flushed-by-this-lease`; readonly tree full file sync and root publication are refused. Defaults for writable/move trees remain unchanged. Unpublished local metadata cleanup retains exact private DELETE file HANDLEs, records partial/committed uncertainty and preserves portable immutable objects/receipt.

Real-host coverage includes SHA1/SHA256, source GC/cache loss, abrupt intent/manifest/receipt exits, actual SQLite receipts, 33 MiB streams, budgets, drafts, external winners, ACL/corruption refusal and real post-delete closed-parent failure. Three cases exercise actual Workspace/SessionIndex business report/archive/accept authorization, cold component reload and Git acceptance, collection CAS and explicit inspect-only recovery. Lost-callback injection occurs after a real SQLite commit; it is not native UNKNOWN/power-loss injection. Tests directly construct business components, without Workspace.open/Controller, a host owner, Pi/Worker or stopped facts. W2/host admission, hostile Git descendants/cleanup races, complete closure/dependencies/transactions, namespace durability and the app package remain unqualified; production selectors stay disabled.

## Supervisor host anchor and local database custody (2026-11-02)

The explicit supervisor now retains the original native host anchor, local ui.sqlite and directory chains after host death. A one-use type-tagged W1 bundle passes restricted duplicate handles through a bounded read-only native manifest and exact HANDLE_LIST. Entity/ACL checks and a fingerprint excluding HANDLE values bind the handoff to the endpoint; observed drift remains fenced. No numeric HANDLE reaches JS or persistent registrations. Retained sharing restrictions deny another anchor writer and database/directory replacement after original host exit. Normal Pi retirement observes supervisor shutdown before host release; closing an observation or losing a helper supplies no retirement proof.

W1 was changed and rebuilt: source/extracted Node/Electron each pass264/264. W2 source/extracted hosts each pass134/134, including7 new custody cases and22 actual Pi cases. Evidence: W1/custody-roundtrip-final/component-roundtrip.json and W2/custody-roundtrip-first/process-component-roundtrip.json; final dual builds W2/build-custody.json. Shared regression37pass/2Linuxskip; selected UNKNOWN budget1/1. Full budget suite separately remains unqualified (3pass/12fail through the unsupported production persistence path). Catalog/project.sqlite, full historical members/cold output/journal/business recovery, production opening and complete app packaging remain unqualified. All production selectors stay disabled.

## Native host source binding (2026-11-03)

Explicit host custody now retains the original catalog.sqlite, project.sqlite and read-only project.json alongside the host anchor/local database. Fresh shared SQLite values and revisions are checked around admission/registration; unrelated writes remain allowed. The original helper independently retains the source-record SHA-256 in native manifest v3/protocol v4. Cold inspection rejects coordinated rewriting of source revisions and host declarations, and native reconnect rejects forged endpoint digests. This is observation only: no cross-database atomicity, business adoption, release or automatic replay. Rebuilt W1 source/extracted Node/Electron each pass264/264; W2 each143/143 with the actual Pi runtime. Evidence: W2/source-binding-roundtrip-verified/process-component-roundtrip.json and W1/source-binding-roundtrip-final/component-roundtrip.json. Production gates and full app qualification remain disabled.

## Private journal lifetime custody (2026-11-14)

`parent.openPrivateJournal(name, createOnly=false)` returns a journal lease
`{created, stat(), verify(), readAt(offset, count), append(bytes, expectedSize),
rewrite(bytes, expectedSha256), sync(), close()}` over the original final-name
file. The lease opens one HANDLE with GENERIC_READ | GENERIC_WRITE |
READ_CONTROL | SYNCHRONIZE and FILE_SHARE_READ sharing only, making it the
exclusive data writer: every independently opened contender requesting data
write or delete access fails with a sharing violation while the lease is held.
Independent readers remain possible. `createOnly=true` publishes the exact
final name through FILE_CREATE with the protected current-user-only descriptor
supplied atomically to NtCreateFile; the returned `created` flag reports
FILE_CREATED and the same HANDLE serves every later operation, so no reopen
gap ever exists. Existing opens require the private protected parent policy and
the inherited current-user-only file policy (exact single user ACE). Every call
re-verifies the pinned parent chain, parent and file policy, File ID, size,
single link, default streams only and reparse rejection; alternate streams,
hard links, reparse points and ACL drift are refused, never repaired.

`stat()` returns the entity `identity` text and `size` as a BigInt.
`readAt(offset, count)` accepts safe-integer offsets and 1..1048576 bytes.
`append(bytes, expectedSize)` takes a non-shared Uint8Array of at most 1 MiB
written directly from caller memory (no intermediate copy) and a number or
BigInt safe integer. It is compare-and-append: the current file size must equal
`expectedSize` (the expected append offset), the bytes must progress to
completion, and the resulting full size must equal `expectedSize + bytes.length`;
the lease then refreshes its own snapshot. `rewrite(bytes, expectedSha256)`
takes a non-shared Uint8Array of at most 64 MiB plus a 32-byte Uint8Array
digest, streams the original content through Windows BCrypt SHA-256 and refuses
on digest mismatch before any mutation; on match it overwrites and truncates
through the same HANDLE and refreshes the snapshot. `sync()` flushes file
buffers; `close()` is explicit and idempotent, works on a failed lease, and
never deletes the file.

Pre-mutation refusals (`FS_JOURNAL_SIZE_MISMATCH`, `FS_JOURNAL_DIGEST_MISMATCH`,
`FS_STAGE_CHANGED`, `FS_SECURITY_CHANGED`, `FS_STREAMS_UNSUPPORTED`,
`FS_ENTRY_REJECTED`, `FS_NAME_REJECTED`, sharing/`WIN32_IO_ERROR`) leave the
lease usable. Any partial or size-unknown mutation failure carries
`committed:true` and `durability:'uncertain'` and poisons the lease
permanently: every subsequent method except `close()` fails with
`FS_JOURNAL_POISONED` (also carrying committed/uncertain facts), so no fake
success can follow a partial write. Digest hashing failures use
`FS_JOURNAL_HASH_FAILED`. There is no deletion fallback, ACL repair or
path-based reopen on any failure path. This adds lifetime custody only; the
binding.gyp inputs are unchanged (`bcrypt.lib` already linked), the binary must
be rebuilt and re-fingerprinted, and hostile mapped/security races, power-loss
durability and complete journal consumer integration remain unqualified.
