/**
 * Actual CollabHost -> local relay -> CollabSocket -> AgentSession integration.
 * Uses only createMockModel: no provider requests, copied host logic, or manual
 * admission lifecycle calls. Run after applying the integration to the clone:
 *   bun --no-env-file tests/accepted-replay-fixture.ts
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

if (!process.env.UPSTREAM_CLONE) throw new Error("Set UPSTREAM_CLONE to the patched source printed by prepare-private-runtime.mjs");
const UPSTREAM = resolve(process.env.UPSTREAM_CLONE);
const CLONE = `${UPSTREAM}/packages/coding-agent`;
const adjudicatorPath = join(import.meta.dir, "accepted-replay-allow.cjs");
const sandbox = await mkdtemp(join(tmpdir(), "nozeli-actual-host-"));
const previousCwd = process.cwd();
const environmentKeys = ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "PI_CODING_AGENT_DIR", "OMP_PROFILE", "PI_PROFILE", "NOZELI_MANAGED_COLLAB", "NOZELI_ADMISSION_MODULE"] as const;
const previousEnv = new Map(environmentKeys.map(key => [key, process.env[key]]));

// Dynamic imports intentionally exercise a module-loading boundary: static
// upstream imports would access user config before sandbox binding below.
// Upstream utils freeze directories at import time. Isolate BEFORE loading any
// upstream runtime module, including its registry, auth and settings helpers.
process.env.HOME = sandbox;
for (const key of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME"] as const) process.env[key] = sandbox;
process.env.PI_CODING_AGENT_DIR = join(sandbox, "agent");
delete process.env.OMP_PROFILE;
delete process.env.PI_PROFILE;
process.env.NOZELI_MANAGED_COLLAB = "1";
process.env.NOZELI_ADMISSION_MODULE = adjudicatorPath;
process.chdir(sandbox);
await mkdir(process.env.PI_CODING_AGENT_DIR, { recursive: true });

let cleanupRuntime: (() => Promise<void>) | undefined;
let checks = 0;
function check(name: string, condition: boolean): void {
	assert.ok(condition, name);
	checks++;
	console.log(`PASS ${name}`);
}
async function within<T>(promise: Promise<T>, label: string): Promise<T> {
	const deadline = Promise.withResolvers<never>();
	const timer = setTimeout(() => deadline.reject(new Error(`timeout: ${label}`)), 10_000);
	try { return await Promise.race([promise, deadline.promise]); }
	finally { clearTimeout(timer); }
}

try {
	const { createMockModel } = await import(`${UPSTREAM}/packages/ai/src/providers/mock.ts`);
	const { Agent } = await import(`${UPSTREAM}/packages/agent/src/agent.ts`);
	const { AgentSession } = await import(`${CLONE}/src/session/agent-session.ts`);
	const { convertToLlm } = await import(`${CLONE}/src/session/messages.ts`);
	const { SessionManager } = await import(`${CLONE}/src/session/session-manager.ts`);
	const { Settings } = await import(`${CLONE}/src/config/settings.ts`);
	const { ModelRegistry } = await import(`${CLONE}/src/config/model-registry.ts`);
	const { createInMemoryAuthStorage } = await import(`${CLONE}/test/helpers/agent-session-setup.ts`);
	const { CollabHost } = await import(`${CLONE}/src/collab/host.ts`);
	const { CollabSocket } = await import(`${CLONE}/src/collab/relay-client.ts`);
	const { COLLAB_PROTO, parseCollabLink } = await import(`${CLONE}/src/collab/protocol.ts`);
	const { importRoomKey } = await import(`${CLONE}/src/collab/crypto.ts`);
	const { nozeliContentDigest } = await import(`${CLONE}/src/collab/nozeli-admission.ts`);
	const { startLocalRelay } = await import(`${UPSTREAM}/packages/collab-web/scripts/local-relay.ts`);
	const { encodeRawPng } = await import(`${CLONE}/src/utils/png-encode.ts`);
	type Message = Parameters<typeof mock.stream>[1]["messages"][number];
	type InteractiveModeContext = ConstructorParameters<typeof CollabHost>[0];
	type CollabFrame = Parameters<InstanceType<typeof CollabSocket>["onFrame"]>[0];

	const authStorage = createInMemoryAuthStorage();
	authStorage.keys.setRuntime("anthropic", "fixture-local-only");
	const mock = createMockModel({ provider: "anthropic", responses: [{ content: ["accepted ", "done"] }] });
	// Real models have no call-history field. Keep mock instrumentation fully
	// inspectable without serializing its cyclic contexts into host state frames.
	Object.defineProperty(mock, "calls", { enumerable: false });
	// MockModel defaults to text-only; enable image input so Session delivers
	// images instead of invoking its image-description fallback.
	mock.input.push("image");
	// Agent reuses/clears its ephemeral provider context after the turn. Record
	// the actual stream boundary before handing that same context to the mock.
	const receivedMessages: Message[][] = [];
	const manager = SessionManager.inMemory(sandbox);
	const settings = Settings.isolated({ "compaction.enabled": false, "retry.enabled": false, "todo.enabled": false });
	const session = new AgentSession({
		agent: new Agent({
			getApiKey: () => "fixture-local-only",
			initialState: { model: mock, systemPrompt: [], tools: [] },
			// Match SDK Agent wiring: the agent-core default drops custom
			// messages, including the real host's image-bearing collab prompt.
			convertToLlm,
			streamFn: (model, context, options) => {
				receivedMessages.push(structuredClone(context.messages));
				return mock.stream(model, context, options);
			},
		}),
		sessionManager: manager,
		settings,
		modelRegistry: new ModelRegistry(authStorage, join(sandbox, "models.yml")),
	});
	const ended = Promise.withResolvers<void>();
	const unsubscribe = session.subscribe(event => {
		if (event.type === "agent_end" && !("willContinue" in event && event.willContinue) && !("awaitingAsyncWork" in event && event.awaitingAsyncWork)) ended.resolve();
	});
	const host = new CollabHost({
		session, sessionManager: manager, settings,
		editor: { getText: () => "" },
		statusLine: { setCollabStatus: () => {}, invalidate: () => {}, getCachedContextBreakdown: () => ({ usedTokens: 0, contextWindow: 0 }) },
		ui: { requestRender: () => {} }, showStatus: () => {},
	} as unknown as InteractiveModeContext);
	const relay = startLocalRelay();
	let guest: InstanceType<typeof CollabSocket> | undefined;
	cleanupRuntime = async () => {
		guest?.close();
		try { await host.stop("fixture complete"); }
		finally {
			relay.stop();
			unsubscribe();
			try { await session.dispose(); } finally { authStorage.close(); }
		}
	};
	await within(host.start(relay.url), "host start");
	const parsed = parseCollabLink(host.link);
	assert.ok(!("error" in parsed) && parsed.writeToken, "local control link available");
	guest = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key: await importRoomKey(parsed.key) });
	const frames: CollabFrame[] = [];
	const observedFrames: CollabFrame[] = [];
	const waiters = new Set<() => void>();
	guest.onFrame = frame => { observedFrames.push(frame); frames.push(frame); for (const wake of [...waiters]) wake(); };
	async function take(predicate: (frame: CollabFrame) => boolean, label: string): Promise<CollabFrame> {
		const ready = Promise.withResolvers<CollabFrame>();
		const wake = () => {
			const index = frames.findIndex(predicate);
			if (index >= 0) { waiters.delete(wake); ready.resolve(frames.splice(index, 1)[0]!); }
		};
		waiters.add(wake);
		wake();
		try { return await within(ready.promise, label); } finally { waiters.delete(wake); }
	}
	guest.onOpen = () => guest!.send({ t: "hello", proto: COLLAB_PROTO, name: "local-fixture", writeToken: Buffer.from(parsed.writeToken!).toString("base64url") });
	guest.connect();
	const welcome = await take(frame => frame.t === "welcome", "guest welcome");
	assert.ok(welcome.t === "welcome" && welcome.nozeli?.managedCollab === 1, "actual host managed capability");
	const epoch = welcome.nozeli.epoch;
	// Real 200x200 PNGs stay above Session's minimum dimension and below its
	// resize budget, so the expected provider-context bytes remain exact.
	const images = [40, 200].map(value => ({
		type: "image" as const, mimeType: "image/png",
		data: encodeRawPng(new Uint8Array(200 * 200 * 3).fill(value), 200, 200, 3).toString("base64"),
	}));
	const refs = ["upload-a", "upload-b"];
	for (const [index, image] of images.entries()) {
		guest.send({ t: "attach-open", ep: epoch, up: refs[index]!, mime: image.mimeType });
		const split = Math.floor(image.data.length / 8) * 4;
		guest.send({ t: "attach-chunk", ep: epoch, up: refs[index]!, data: image.data.slice(0, split) });
		guest.send({ t: "attach-chunk", ep: epoch, up: refs[index]!, data: image.data.slice(split) });
		guest.send({ t: "attach-close", ep: epoch, up: refs[index]! });
	}
	const original = { t: "prompt" as const, rid: "actual-host-accepted-0001", ep: epoch, at: 1, ar: "fixture-local-job", text: "accepted text", refs, dg: nozeliContentDigest(epoch, "prompt", "accepted text", images)! };
	guest.send(original);
	const admitted = await take(frame => frame.t === "action-receipt" && frame.rid === original.rid && frame.status !== "pending", "accepted receipt");
	check("actual host admits uploaded image prompt", admitted.t === "action-receipt" && admitted.status === "admitted");
	await within(ended.promise, "real Session terminal event");
	const synced = "stream-lifecycle-fixture";
	guest.send({ t: "nozeli-sync", nonce: synced });
	await take(frame => frame.t === "nozeli-sync" && frame.nonce === synced, "stream lifecycle barrier");
	const assistantFrames = observedFrames.filter(frame => frame.t === "nozeli-event" && ["message_start", "message_update", "message_end"].includes(frame.event.type) && "message" in frame.event && frame.event.message.role === "assistant");
	const streamIds = new Set(assistantFrames.map(frame => frame.t === "nozeli-event" ? frame.streamId : null));
	console.log(JSON.stringify({ assistantLifecycle: assistantFrames.map(frame => frame.t === "nozeli-event" ? { type: frame.event.type, streamId: frame.streamId } : null), appendedStreams: observedFrames.filter(frame => frame.t === "nozeli-entry-part" && frame.streamId).map(frame => frame.t === "nozeli-entry-part" ? { id: frame.id, index: frame.index, final: frame.final, streamId: frame.streamId } : null) }));
	check("fresh assistant snapshots retain exactly one native stream identity", assistantFrames.some(frame => frame.t === "nozeli-event" && frame.event.type === "message_update") && streamIds.size === 1 && !streamIds.has(null));
	const assistantParts = observedFrames.filter(frame => frame.t === "nozeli-entry-part" && frame.streamId && streamIds.has(frame.streamId));
	check("native appended assistant entry replaces its exact event lifecycle", assistantParts.some(frame => frame.t === "nozeli-entry-part" && frame.final));
	check("real Session mock invoked once", mock.calls.length === 1);
	check("one provider-boundary context captured", receivedMessages.length === 1);
	const delivered = receivedMessages[0]!.flatMap(message => Array.isArray(message.content) ? message.content.filter(part => part.type === "image") : []);
	if (delivered.length !== images.length || delivered.some((image, index) => image.type !== "image" || image.mimeType !== images[index]?.mimeType || image.data !== images[index]?.data)) {
		console.error(JSON.stringify({
			imageDeliveryMismatch: {
				messages: receivedMessages[0]!.map(message => ({ role: message.role, contentTypes: Array.isArray(message.content) ? message.content.map(part => part.type) : [typeof message.content] })),
				expected: images.map(image => ({ mime: image.mimeType, length: image.data.length, digest: createHash("sha256").update(image.data).digest("hex") })),
				actual: delivered.map(image => ({ mime: image.mimeType, length: image.data.length, digest: createHash("sha256").update(image.data).digest("hex") })),
			},
		}));
	}
	check("mock receives both image payloads in order", delivered.length === images.length && delivered.every((image, index) => image.type === "image" && image.mimeType === images[index]!.mimeType && image.data === images[index]!.data));
	check("mock image content digests match uploads", delivered.every((image, index) => image.type === "image" && createHash("sha256").update(image.data).digest("hex") === createHash("sha256").update(images[index]!.data).digest("hex")));

	async function replay(name: string): Promise<void> {
		guest!.send(original);
		const receipt = await take(frame => frame.t === "action-receipt" && frame.rid === original.rid && frame.status !== "pending", name);
		check(name, JSON.stringify(receipt) === JSON.stringify(admitted));
	}
	await replay("exact postcommit replay returns original admitted receipt");
	// Fresh identity cannot use consumed uploads. This request traverses the
	// actual host's peek/confirm path, rather than inspecting its private buffer.
	guest.send({ ...original, rid: "actual-host-consumed-0002", at: 2 });
	const consumed = await take(frame => frame.t === "action-receipt" && frame.rid === "actual-host-consumed-0002" && frame.status !== "pending", "consumed refs rejection");
	check("committed uploads unavailable to a fresh request", consumed.t === "action-receipt" && consumed.status === "rejected");

	async function rejected(name: string, changed: Partial<typeof original> & { images?: typeof images }): Promise<void> {
		guest!.send({ ...original, ...changed });
		const error = await take(frame => frame.t === "error", name);
		check(name, error.t === "error" && error.message.startsWith("replay rejected:"));
	}
	await rejected("changed text replay rejected", { text: "tampered text" });
	await rejected("changed ref identity replay rejected", { refs: ["other-upload", refs[1]!] });
	await rejected("changed ref order replay rejected", { refs: [...refs].reverse() });
	await rejected("inline replacement replay rejected", { refs: [], images });
	await rejected("inline MIME tamper replay rejected", { refs: [], images: [{ ...images[0]!, mimeType: "image/jpeg" }, images[1]!] });
	await rejected("inline bytes tamper replay rejected", { refs: [], images: [{ ...images[0]!, data: images[1]!.data }, images[1]!] });

	// Ref IDs remain immutable after commit: neither changed MIME nor changed
	// content can install a new upload behind a retained request descriptor.
	for (const [name, mime] of [["changed MIME", "image/jpeg"], ["same MIME", images[0]!.mimeType]] as const) {
		guest.send({ t: "attach-open", ep: epoch, up: refs[0]!, mime });
		const error = await take(frame => frame.t === "error", `ref reuse ${name}`);
		check(`consumed ref reuse with ${name} rejected before new content`, error.t === "error" && error.message.includes("duplicate"));
		// Do not send chunks after a rejected open: that would be an unrelated
		// invalid-upload probe, not a successfully installed replacement.
		await replay(`exact replay survives rejected ${name} ref reuse`);
	}
	check("all replays and tamper attempts leave exactly one mock invocation", mock.calls.length === 1);
	console.log(`fixture summary: ${checks}/${checks} passed`);
} catch (error) {
	// Do not dump guest frames, links, write tokens, or model contexts on failure.
	console.error(error instanceof Error && (error.name === "AssertionError" || error.message.startsWith("timeout:")) ? error.message : "actual-host fixture failed during setup or transport");
	process.exitCode = 1;
} finally {
	try { await cleanupRuntime?.(); }
	finally {
		process.chdir(previousCwd);
		for (const [key, value] of previousEnv) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
		await rm(sandbox, { recursive: true, force: true });
	}
}
