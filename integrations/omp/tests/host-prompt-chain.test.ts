/**
 * Real-AgentSession busy-race fixture (no network): drives the managed prompt
 * chain (submitManagedPrompt) against a REAL AgentSession whose model stream
 * is the upstream mock provider with a controlled delay. Proves the round-1
 * "no await between check and dispatch" claim is unnecessary: with
 * streamingBehavior omitted, upstream closes the race itself — a prompt that
 * arrives while a turn is streaming throws AgentBusyError instead of
 * queueing/steering, and the mock model is invoked exactly once.
 *
 * Imports bind to the rebuilt, patched checkout selected by UPSTREAM_CLONE;
 * the test imports no Nozeli product runtime.
 */
import { describe, expect, test } from "bun:test";

// The checkout is runtime-selected so this exercises the parent's rebuilt source.
const UPSTREAM = process.env.UPSTREAM_CLONE;
if (!UPSTREAM) throw new Error("Set UPSTREAM_CLONE to the patched source printed by prepare-private-runtime.mjs");
const CLONE = `${UPSTREAM}/packages/coding-agent`;
const { Agent, AgentBusyError } = await import(`${UPSTREAM}/packages/agent/src/agent.ts`);
const { createMockModel, MockModel } = await import(`${UPSTREAM}/packages/ai/src/providers/mock.ts`);
const { AgentSession } = await import(`${CLONE}/src/session/agent-session.ts`);
const { SessionManager } = await import(`${CLONE}/src/session/session-manager.ts`);
const { Settings } = await import(`${CLONE}/src/config/settings.ts`);
const { ModelRegistry } = await import(`${CLONE}/src/config/model-registry.ts`);
const { createInMemoryAuthStorage } = await import(`${CLONE}/test/helpers/agent-session-setup.ts`);
const {
	createNozeliAdmission,
	nozeliContentDigest,
	submitManagedPrompt,
	bindNozeliBusyError,
} = await import("../src/nozeli-admission.ts");
bindNozeliBusyError(AgentBusyError);
import type { NozeliAdmission } from "../src/nozeli-admission";

const EPOCH = "race-session#0";
const PROMPT_TYPE = "nozeli-collab-prompt";

interface Harness {
	session: InstanceType<typeof AgentSession>;
	mock: MockModel;
	gate: NozeliAdmission;
	dispose(): Promise<void>;
}

interface MockScript {
	content: string[];
	delayMs?: number;
}

async function createHarness(responses: MockScript[]): Promise<Harness> {
	const authStorage = createInMemoryAuthStorage();
	authStorage.keys.setRuntime("anthropic", "test-key");
	const mock = createMockModel({ provider: "anthropic", responses });
	const settings = Settings.isolated({
		"compaction.enabled": false,
		"retry.enabled": false,
		"todo.enabled": false,
	});
	const session = new AgentSession({
		agent: new Agent({
			getApiKey: () => "test-key",
			initialState: { model: mock, systemPrompt: [], tools: [] },
			streamFn: mock.stream,
		}),
		sessionManager: SessionManager.inMemory(),
		settings,
		modelRegistry: new ModelRegistry(authStorage, "/tmp/nozeli-race-models.yml"),
	});
	session.subscribe(() => {});
	const gate = createNozeliAdmission({ admitAction: () => ({ decision: "allow" }) });
	gate.beginEpoch(EPOCH);
	return {
		session,
		mock,
		gate,
		async dispose() {
			await session.dispose();
			authStorage.close();
		},
	};
}

const busyFacts = (session: InstanceType<typeof AgentSession>) => ({
	busy: session.isStreaming || session.isAborting || session.queuedMessageCount > 0 || session.isSessionTransitioning,
	hasActiveTurn: session.isStreaming,
});

const admitPrompt = (harness: Harness, rid: string, at: number, text: string) => {
	const decision = harness.gate.admit({
		kind: "prompt",
		rid,
		at,
		ep: EPOCH,
		ar: "job-race",
		canWrite: true,
		...busyFacts(harness.session),
	});
	if (decision.decision === "reserved") {
		const dg = nozeliContentDigest(EPOCH, "prompt", text);
		harness.gate.confirm(rid, dg ?? "", dg);
		harness.gate.adjudicate(rid);
	}
	return decision;
};

/**
 * Integration exception: `isStreaming` is an external platform condition with
 * no exposed promise, so poll the real signal (never a guessed duration); the
 * mock's long delay holds the turn open and the loop exits on the condition.
 */
async function waitForStreaming(session: InstanceType<typeof AgentSession>): Promise<boolean> {
	const deadline = Date.now() + 10_000;
	while (!session.isStreaming && Date.now() < deadline) await Bun.sleep(25);
	return session.isStreaming;
}

describe("managed prompt chain against a real session (mock model, no network)", () => {
	test("admitted prompt reports onPromptAdmitted then settles admitted, exactly one model call", async () => {
		const harness = await createHarness([{ content: ["done"], delayMs: 120 }]);
		try {
			const decision = admitPrompt(harness, "race-rid-0001", 1, "first");
			expect(decision.decision).toBe("reserved");
			let admittedFired = 0;
			const outcome = await submitManagedPrompt(harness.session, { customType: PROMPT_TYPE }, "first", [], () => {
				admittedFired++;
				harness.gate.markAdmitted("race-rid-0001");
			});
			expect(admittedFired).toBe(1);
			expect(outcome).toEqual({ settle: "admitted" });
			harness.gate.settle("race-rid-0001", outcome.settle, outcome.reason);
			const settled = harness.gate.query("race-rid-0001");
			expect(settled.status).toBe("ok");
			if (settled.status === "ok") expect(settled.receipts.at(-1)?.status).toBe("admitted");
			expect(harness.mock.calls).toHaveLength(1);
		} finally {
			await harness.dispose();
		}
	});

	test("prompt arriving mid-turn is busy-rejected by the gate and throws AgentBusyError upstream — no steer, no second model call", async () => {
		const harness = await createHarness([{ content: ["slow"], delayMs: 60_000 }]);
		try {
			const first = admitPrompt(harness, "race-rid-0002", 1, "slow turn");
			expect(first.decision).toBe("reserved");
			const firstDone = submitManagedPrompt(harness.session, { customType: PROMPT_TYPE }, "slow turn", [], () => {
				harness.gate.markAdmitted("race-rid-0002");
			}).then(outcome => {
				harness.gate.settle("race-rid-0002", outcome.settle, outcome.reason);
				return outcome;
			});
			expect(await waitForStreaming(harness.session)).toBe(true);
			// The gate sees the held (provisional-admitted) first prompt and
			// hard-rejects the second: outstanding-pending is the stronger,
			// earlier fence; plain `busy` is the post-settle variant covered in
			// the unit tests.
			const second = admitPrompt(harness, "race-rid-0003", 2, "second");
			expect(second.receipt.status).toBe("rejected");
			expect(second.receipt).toMatchObject({ status: "rejected", reason: "outstanding-pending" });
			// Even a direct unguarded submission cannot queue/steer: upstream
			// throws because streamingBehavior is omitted in the managed chain.
			await expect(
				harness.session.promptCustomMessage(
					{ customType: PROMPT_TYPE, content: "direct unguarded", display: true, attribution: "user" },
				),
			).rejects.toBeInstanceOf(AgentBusyError);
			// Exactly one model call: the busy racer never reached the provider.
			expect(harness.mock.calls).toHaveLength(1);
			await harness.session.abort({ reason: "test teardown" });
			expect((await firstDone).settle).toBeDefined();
		} finally {
			await harness.dispose();
		}
	});

	test("abort during the held turn settles executed and ends the streaming state", async () => {
		const harness = await createHarness([{ content: ["held"], delayMs: 60_000 }]);
		try {
			const promptDecision = admitPrompt(harness, "race-rid-0004", 1, "held turn");
			expect(promptDecision.decision).toBe("reserved");
			const promptDone = submitManagedPrompt(harness.session, { customType: PROMPT_TYPE }, "held turn", [], () => {
				harness.gate.markAdmitted("race-rid-0004");
			});
			expect(await waitForStreaming(harness.session)).toBe(true);
			harness.gate.beginDispatch("race-rid-0004");
			harness.gate.onTurnStart(); // host wiring feeds turn events to the gate
			const abortDg = nozeliContentDigest(EPOCH, "abort", "", [], "race-rid-0004");
			const abortDecision = harness.gate.admit({
				kind: "abort",
				rid: "race-abort-001",
				at: 2,
				ep: EPOCH,
				ar: "job-race",
				tr: "race-rid-0004",
				canWrite: true,
				...busyFacts(harness.session),
			});
			harness.gate.confirm("race-abort-001", abortDg ?? "", abortDg);
			harness.gate.adjudicate("race-abort-001");
			expect(abortDecision.decision).toBe("reserved");
			await harness.session.abort({ reason: "user interrupt" });
			harness.gate.settle("race-abort-001", "executed");
			const settledAbort = harness.gate.query("race-abort-001");
			expect(settledAbort.status).toBe("ok");
			if (settledAbort.status === "ok") expect(settledAbort.receipts.at(-1)?.status).toBe("executed");
			await promptDone;
		} finally {
			await harness.dispose();
		}
	});
});

test("native final admission guard observes a draft entered across preparation await", async () => {
	const harness = await createHarness([{ content: ["must not run"] }]);
	let editorText = "";
	let admitted = 0;
	try {
		const pending = submitManagedPrompt(harness.session, { customType: PROMPT_TYPE }, "guarded", [], () => { admitted++; }, () => {
			if (editorText.length > 0) throw new AgentBusyError();
		});
		// Real promptCustomMessage suspends on its native maintenance barrier.
		editorText = "operator draft";
		expect(await pending).toEqual({ settle: "rejected", reason: "busy-race" });
		expect(admitted).toBe(0);
		expect(harness.mock.calls.length).toBe(0);
		expect(harness.session.sessionManager.getBranch().some(entry => entry.type === "custom_message" && entry.customType === PROMPT_TYPE)).toBe(false);
	} finally { await harness.dispose(); }
});
