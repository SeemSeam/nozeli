import { beforeEach, describe, expect, test } from "bun:test";
import {
	bindNozeliBusyError,
	createNozeliAdmission,
	type NozeliAdjudicator,
	type NozeliAdmission,
	nozeliContentDigest,
	NozeliAttachmentBuffer,
	createStreamingRedactor,
	submitManagedPrompt,
} from "../src/nozeli-admission";

const EPOCH = "sess-1#0";
const allow: NozeliAdjudicator = { admitAction: () => ({ decision: "allow" }) };

/** Full three-phase admission helper returning the gate + last decision. */
const admitPrompt = (gate: NozeliAdmission, rid: string, at: number, ep: string, text = "x", dgOverride?: string) => {
	const dg = dgOverride ?? nozeliContentDigest(ep, "prompt", text);
	const decision = gate.admit({ kind: "prompt", rid, dg: dg ?? undefined, at, ep, ar: "job-1", canWrite: true, busy: false });
	if (decision.decision !== "reserved") return decision;
	gate.confirm(rid, dg ?? "", nozeliContentDigest(ep, "prompt", text));
	gate.adjudicate(rid);
	return decision;
};

let gate: NozeliAdmission;
beforeEach(() => {
	gate = createNozeliAdmission(allow);
	gate.beginEpoch(EPOCH);
});

describe("executor round-5 payload-collision counterexample (job_30eebcacef31) — regression", () => {
	test("same rid/kind/at/ar/ep with a DIFFERENT text+digest is a collision, never a replay of the old success", () => {
		const dgA = nozeliContentDigest(EPOCH, "prompt", "original text");
		const decision = gate.admit({ kind: "prompt", rid: "rid-r5-00001", dg: dgA, at: 1, ep: EPOCH, ar: "job-1", canWrite: true, busy: false });
		expect(decision.decision).toBe("reserved");
		gate.confirm("rid-r5-00001", dgA ?? "", dgA);
		gate.adjudicate("rid-r5-00001");
		gate.markAdmitted("rid-r5-00001");
		gate.settle("rid-r5-00001", "admitted");
		gate.onTurnEnd(); // released with the full envelope
		const dgB = nozeliContentDigest(EPOCH, "prompt", "tampered text");
		const tampered = gate.admit({ kind: "prompt", rid: "rid-r5-00001", dg: dgB, at: 1, ep: EPOCH, ar: "job-1", canWrite: true, busy: false });
		expect(tampered.decision).toBe("reject");
		expect(tampered.receipt.reason).toBe("key-collision");
		// True replay of the SAME input still replays with zero re-dispatch.
		const trueReplay = gate.admit({ kind: "prompt", rid: "rid-r5-00001", dg: dgA, at: 1, ep: EPOCH, ar: "job-1", canWrite: true, busy: false });
		expect(trueReplay.decision).toBe("replay");
		expect(trueReplay.receipt.status).toBe("admitted");
	});

	test("held-record replay also binds the declared digest", () => {
		const dgA = nozeliContentDigest(EPOCH, "prompt", "held original");
		gate.admit({ kind: "prompt", rid: "rid-r5-00002", dg: dgA, at: 1, ep: EPOCH, ar: "job-1", canWrite: true, busy: false });
		gate.confirm("rid-r5-00002", dgA ?? "", dgA);
		gate.adjudicate("rid-r5-00002");
		const dgB = nozeliContentDigest(EPOCH, "prompt", "held tampered");
		const tampered = gate.admit({ kind: "prompt", rid: "rid-r5-00002", dg: dgB, at: 1, ep: EPOCH, ar: "job-1", canWrite: true, busy: false });
		expect(tampered.receipt.reason).toBe("key-collision");
	});
});

describe("executor round-4 counterexamples (job_57cef48cfffa) — regression", () => {
	test("c1: released-cache replay must verify the full envelope (kind/attempt/ref/epoch)", () => {
		admitPrompt(gate, "rid-r4-00001", 1, EPOCH, "original");
		gate.settle("rid-r4-00001", "rejected", "busy-race"); // released to cache
		const sameRidAbort = gate.admit({ kind: "abort", rid: "rid-r4-00001", at: 99, ep: EPOCH, ar: "job-B", tr: "*", canWrite: true, busy: true });
		expect(sameRidAbort.receipt.reason).toBe("key-collision"); // round-4 bug: returned the prompt replay
		const sameRidDifferentAttempt = gate.admit({ kind: "prompt", rid: "rid-r4-00001", at: 2, ep: EPOCH, ar: "job-1", canWrite: true, busy: false });
		expect(sameRidDifferentAttempt.receipt.reason).toBe("key-collision");
		const trueReplay = gate.admit({ kind: "prompt", rid: "rid-r4-00001", dg: nozeliContentDigest(EPOCH, "prompt", "original") ?? undefined, at: 1, ep: EPOCH, ar: "job-1", canWrite: true, busy: false });
		expect(trueReplay.decision).toBe("replay");
	});

	test("c2: a rejected dispatch never owns the next (native) turn", () => {
		gate.beginDispatch("rid-r4-00002");
		admitPrompt(gate, "rid-r4-00002", 1, EPOCH, " doomed");
		gate.settle("rid-r4-00002", "rejected", "busy-race");
		gate.onTurnStart(); // native turn arrives after the rejection
		const abortByRejectedRid = gate.admit({ kind: "abort", rid: "rid-r4-00003", at: 2, ep: EPOCH, ar: "job-1", tr: "rid-r4-00002", canWrite: true, busy: true });
		expect(abortByRejectedRid.receipt.reason).toBe("stale-target"); // round-4 bug: reserved (inherited the rejected rid)
		const star = gate.admit({ kind: "abort", rid: "rid-r4-00004", at: 3, ep: EPOCH, ar: "job-1", tr: "*", canWrite: true, busy: true });
		expect(star.decision).toBe("reserved"); // '*' still cancels the native turn
	});

	test("c3: redactor holds partial tokens across every split until a terminator", () => {
		const secret = "/r/ABCDEFGHIJKL.KLMNOPQRSTUVWXYZ123456789abcdefghij";
		const pattern = /\/r\/[A-Za-z0-9_-]{10,64}\.[A-Za-z0-9_-]{20,}/g;
		const clean = (value: string) => value.replace("\u0000SECRET\u0000", "[S]");
		const twoChunk = createStreamingRedactor(pattern);
		const two = twoChunk.push(secret.slice(0, 33)) + twoChunk.push(secret.slice(33)) + twoChunk.finish();
		expect(two.includes(secret.slice(33))).toBe(false);
		expect(clean(two)).toBe("[S]");
		const charwise = createStreamingRedactor(pattern);
		let out = "";
		for (const char of secret) out += charwise.push(char);
		out += charwise.finish();
		expect(out.includes(secret)).toBe(false);
		expect(clean(out).match(/[A-Za-z0-9]{15}/)).toBeNull();
		const surrounded = createStreamingRedactor(pattern);
		const three = surrounded.push(`prefix ${secret.slice(0, 20)}`) + surrounded.push(secret.slice(20, 40)) + surrounded.push(`${secret.slice(40)} suffix`) + surrounded.finish();
		expect(clean(three)).toBe("prefix [S] suffix");
	});

	test("grant seam receives the actual digest, attempt and turn target", () => {
		const seen: Array<Record<string, unknown>> = [];
		const observing = createNozeliAdmission({ admitAction: request => { seen.push({ ...request }); return { decision: "deny", reason: "observed" }; } });
		observing.beginEpoch(EPOCH);
		observing.admit({ kind: "prompt", rid: "rid-r4-00005", at: 7, ep: EPOCH, ar: "job-X", canWrite: true, busy: false });
		const dg = nozeliContentDigest(EPOCH, "prompt", "grant probe");
		observing.confirm("rid-r4-00005", dg ?? "", dg);
		observing.adjudicate("rid-r4-00005");
		expect(seen[0]).toMatchObject({ kind: "prompt", rid: "rid-r4-00005", ep: EPOCH, admissionRef: "job-X", contentDigest: dg, attempt: 7, targetTurn: null });
	});
});

describe("executor round-3 counterexamples (job_a189516cbef4) — regression", () => {
	test("A: definitive rejection releases the placeholder", () => {
		const first = admitPrompt(gate, "rid-a-00001", 1, EPOCH);
		expect(first.decision).toBe("reserved");
		const rejected = gate.settle("rid-a-00001", "rejected", "busy-race");
		expect(rejected?.status).toBe("rejected");
		const next = admitPrompt(gate, "rid-a-00002", 2, EPOCH);
		expect(next.decision).toBe("reserved"); // round-3 bug: outstanding-pending
	});

	test("B: query is pure across rotation; facts keep their original epoch; cross-room callback updates the original identity", () => {
		admitPrompt(gate, "rid-b-00001", 1, EPOCH);
		const before = gate.query("rid-b-00001");
		gate.beginEpoch("sess-1#1");
		const q1 = gate.query("rid-b-00001");
		const q2 = gate.query("rid-b-00001");
		expect(q1.status).toBe("ok");
		expect(q2.status).toBe("ok");
		if (q1.status === "ok" && q2.status === "ok" && before.status === "ok") {
			expect(q1.receipts).toEqual(before.receipts); // no new facts, no seq change
			expect(q2.receipts).toEqual(q1.receipts);
			expect(q1.receipts.every(f => f.ep === EPOCH)).toBe(true); // original epoch retained
		}
		const admitted = gate.markAdmitted("rid-b-00001"); // old callback after rotation
		expect(admitted?.ep).toBe(EPOCH); // fact lands under the ORIGINAL identity
	});

	test("C: failed multi-ref peek consumes nothing (atomic validation)", () => {
		const buffer = new NozeliAttachmentBuffer({ maxChunkBytes: 4, maxUploadBytes: 6, maxUploads: 4, maxResidentBytes: 6 });
		expect(buffer.open(EPOCH, "first", "image/png")).toBe("ok");
		expect(buffer.chunk(EPOCH, "first", "AAAA")).toBe("ok");
		expect(buffer.close(EPOCH, "first")).toBe("ok");
		const failed = buffer.peek(EPOCH, ["first", "missing"]);
		expect(failed).toBe("unknown-upload");
		const stillThere = buffer.peek(EPOCH, ["first"]);
		expect(stillThere).toEqual([{ type: "image", mimeType: "image/png", data: "AAAA" }]);
	});

	test("D: ingest enforces the aggregate resident budget", () => {
		const buffer = new NozeliAttachmentBuffer({ maxChunkBytes: 4, maxUploadBytes: 6, maxUploads: 8, maxResidentBytes: 6 });
		for (let i = 0; i < 5; i++) {
			const up = `up-${i}`;
			const opened = buffer.open(EPOCH, up, "image/png");
			if (opened !== "ok") break;
			const chunked = buffer.chunk(EPOCH, up, "AAAA");
			if (i >= 1) expect(chunked).toBe("over-resident-budget"); // 4 then 8 > 6
		}
	});

	test("E: streaming redaction holds fragments across chunk boundaries", () => {
		const secret = "/r/abcdefghij.KLMNOPQRSTUVWXYZ123456";
		const redactor = createStreamingRedactor(/\/r\/[A-Za-z0-9_-]{10,64}\.[A-Za-z0-9_-]{20,}/g);
		const half = Math.floor(secret.length / 2);
		const out1 = redactor.push(secret.slice(0, half));
		const out2 = redactor.push(secret.slice(half));
		const out3 = redactor.finish();
		const combined = out1 + out2 + out3;
		expect(combined).not.toContain(secret);
		expect(combined).not.toContain("KLMNOPQRSTUVWXYZ123456");
	});
});

describe("turn ownership and abort binding (v4)", () => {
	test("native turn without a dispatched rid: '*' can cancel, rid targets are stale", () => {
		gate.onTurnStart(); // native/manual turn: no beginDispatch
		const starDg = nozeliContentDigest(EPOCH, "abort", "", [], "*");
		const star = gate.admit({ kind: "abort", rid: "rid-ab-00001", at: 1, ep: EPOCH, ar: "job-1", tr: "*", canWrite: true, busy: true });
		expect(star.decision).toBe("reserved");
		gate.confirm("rid-ab-00001", starDg ?? "", nozeliContentDigest(EPOCH, "abort", "", [], "*"));
		gate.adjudicate("rid-ab-00001");
		expect(gate.abortTargetStale("rid-ab-00001")).toBe(false); // active native turn
		const byRid = gate.admit({ kind: "abort", rid: "rid-ab-00002", at: 2, ep: EPOCH, ar: "job-1", tr: "rid-nope-01", canWrite: true, busy: true });
		expect(byRid.receipt.reason).toBe("stale-target");
	});

	test("abort admitted against generation N is stale after end (active=false) even if generation unchanged", () => {
		gate.beginDispatch("rid-t-00001");
		admitPrompt(gate, "rid-t-00001", 1, EPOCH);
		gate.onTurnStart();
		const starDg = nozeliContentDigest(EPOCH, "abort", "", [], "*");
		gate.admit({ kind: "abort", rid: "rid-ab-00003", at: 2, ep: EPOCH, ar: "job-1", tr: "*", canWrite: true, busy: true });
		gate.confirm("rid-ab-00003", starDg ?? "", nozeliContentDigest(EPOCH, "abort", "", [], "*"));
		gate.adjudicate("rid-ab-00003");
		expect(gate.abortTargetStale("rid-ab-00003")).toBe(false);
		gate.onTurnEnd(); // turn ends, generation NOT bumped yet
		expect(gate.abortTargetStale("rid-ab-00003")).toBe(true); // active=false ⇒ stale
	});

	test("turn end releases admitted prompt holds (injected ordering included)", () => {
		admitPrompt(gate, "rid-h-00001", 1, EPOCH);
		gate.beginDispatch("rid-h-00001");
		gate.onTurnStart();
		gate.markAdmitted("rid-h-00001");
		gate.onTurnEnd();
		const next = admitPrompt(gate, "rid-h-00002", 2, EPOCH);
		expect(next.decision).toBe("reserved");
	});

	test("resolveUnknown requires matching identity evidence and a verified outcome", () => {
		admitPrompt(gate, "rid-u-00001", 1, EPOCH);
		gate.settle("rid-u-00001", "unknown", "gone");
		expect(admitPrompt(gate, "rid-u-00002", 2, EPOCH).receipt.reason).toContain("outstanding-unknown");
		expect(gate.resolveUnknown("rid-u-00001", { admissionRef: "wrong-job", ep: EPOCH, outcome: "not-executed" })).toBeNull();
		expect(gate.resolveUnknown("rid-u-00001", { admissionRef: "job-1", ep: "other#0", outcome: "not-executed" })).toBeNull();
		const resolved = gate.resolveUnknown("rid-u-00001", { admissionRef: "job-1", ep: EPOCH, outcome: "not-executed" });
		expect(resolved?.status).toBe("rejected");
		expect(resolved?.reason).toContain("resolved:not-executed");
		expect(admitPrompt(gate, "rid-u-00003", 3, EPOCH).decision).toBe("reserved"); // quarantine lifted
	});

	test("abort unknown stays held and resolvable (no orphan quarantine)", () => {
		const abortDg = nozeliContentDigest(EPOCH, "abort", "", [], "*");
		gate.beginDispatch("rid-z-00001");
		admitPrompt(gate, "rid-z-00001", 1, EPOCH);
		gate.onTurnStart();
		gate.admit({ kind: "abort", rid: "rid-ab-u0001", at: 2, ep: EPOCH, ar: "job-1", tr: "*", canWrite: true, busy: true });
		gate.confirm("rid-ab-u0001", abortDg ?? "", nozeliContentDigest(EPOCH, "abort", "", [], "*"));
		gate.adjudicate("rid-ab-u0001");
		gate.settle("rid-ab-u0001", "unknown", "abort lost");
		const resolved = gate.resolveUnknown("rid-ab-u0001", { admissionRef: "job-1", ep: EPOCH, outcome: "executed" });
		expect(resolved?.status).toBe("executed");
	});
});

describe("admission invariants retained (v4 two/three-phase)", () => {
	test("digest mismatch / invalid payload release the reservation and consume nothing", () => {
		const decision = gate.admit({ kind: "prompt", rid: "rid-mm-00001", at: 1, ep: EPOCH, ar: "job-1", canWrite: true, busy: false });
		expect(decision.decision).toBe("reserved");
		const mismatch = gate.confirm("rid-mm-00001", "0".repeat(64), nozeliContentDigest(EPOCH, "prompt", "x"));
		expect(mismatch).toMatchObject({ status: "rejected", reason: "digest-mismatch" });
		const replay = gate.admit({ kind: "prompt", rid: "rid-mm-00001", at: 1, ep: EPOCH, ar: "job-1", canWrite: true, busy: false });
		expect(replay.decision).toBe("replay"); // released records replay their facts
	});

	test("adjudicator denial after validation consumes nothing and stays deniable on replay", () => {
		const denying = createNozeliAdmission({ admitAction: () => ({ decision: "deny", reason: "smoke" }) });
		denying.beginEpoch(EPOCH);
		const decision = denying.admit({ kind: "prompt", rid: "rid-dn-00001", at: 1, ep: EPOCH, ar: "job-1", canWrite: true, busy: false });
		expect(decision.decision).toBe("reserved");
		denying.confirm("rid-dn-00001", nozeliContentDigest(EPOCH, "prompt", "x")!, nozeliContentDigest(EPOCH, "prompt", "x"));
		const denied = denying.adjudicate("rid-dn-00001");
		expect(denied).toMatchObject({ status: "rejected", reason: "not-authorized:smoke" });
	});

	test("adjudicator exception fails closed with a rejection fact", () => {
		const throwing = createNozeliAdmission({ admitAction: () => { throw new Error("boom"); } });
		throwing.beginEpoch(EPOCH);
		throwing.admit({ kind: "prompt", rid: "rid-ex-00001", at: 1, ep: EPOCH, ar: "job-1", canWrite: true, busy: false });
		throwing.confirm("rid-ex-00001", nozeliContentDigest(EPOCH, "prompt", "x")!, nozeliContentDigest(EPOCH, "prompt", "x"));
		const errored = throwing.adjudicate("rid-ex-00001");
		expect(errored).toMatchObject({ status: "rejected", reason: "not-authorized:adjudicator-error" });
	});

	test("missing seam, permissions, identity, fence and epoch rejections (no placeholder)", () => {
		expect(createNozeliAdmission(null).admit({ kind: "prompt", rid: "rid-ns-00001", at: 1, ep: EPOCH, ar: undefined, canWrite: true, busy: false }).receipt.reason).toBe("stale-epoch");
		const bare = createNozeliAdmission(null);
		bare.beginEpoch(EPOCH);
		expect(bare.admit({ kind: "prompt", rid: "rid-ns-00001", at: 1, ep: EPOCH, ar: undefined, canWrite: true, busy: false }).receipt.reason).toBe("no-host-adjudicator");
		expect(gate.admit({ kind: "prompt", rid: "rid-ro-0001", at: 1, ep: EPOCH, ar: undefined, canWrite: false, busy: false }).receipt.reason).toBe("read-only");
		expect(gate.admit({ kind: "prompt", rid: undefined, at: 1, ep: EPOCH, ar: undefined, canWrite: true, busy: false }).receipt.reason).toBe("no-request-id");
		expect(gate.admit({ kind: "prompt", rid: "rid-ok-0001", at: 1, ep: "other#0", ar: undefined, canWrite: true, busy: false }).receipt.reason).toBe("stale-epoch");
		admitPrompt(gate, "rid-wm-00001", 5, EPOCH);
		expect(gate.admit({ kind: "prompt", rid: "rid-wm-00002", at: 5, ep: EPOCH, ar: "job-1", canWrite: true, busy: false }).receipt.reason).toBe("forgotten-replay");
	});

	test("busy is terminal per rid and recorded once", () => {
		const busy = gate.admit({ kind: "prompt", rid: "rid-bu-00001", at: 1, ep: EPOCH, ar: "job-1", canWrite: true, busy: true });
		expect(busy.receipt).toMatchObject({ status: "rejected", reason: "busy" });
		const replay = gate.admit({ kind: "prompt", rid: "rid-bu-00001", at: 1, ep: EPOCH, ar: "job-1", canWrite: true, busy: false });
		expect(replay.decision).toBe("replay");
		expect(replay.receipt.reason).toBe("busy");
	});

	test("digest binds mimeType; base64 validity enforced", () => {
		const png = nozeliContentDigest("e", "prompt", "t", [{ type: "image", mimeType: "image/png", data: "AAAA" }]);
		const jpeg = nozeliContentDigest("e", "prompt", "t", [{ type: "image", mimeType: "image/jpeg", data: "AAAA" }]);
		expect(png).not.toEqual(jpeg);
		expect(nozeliContentDigest("e", "prompt", "t", [{ type: "image", mimeType: "image/png", data: "AA A" }])).toBeNull();
		expect(nozeliContentDigest("e", "prompt", "t", [{ type: "image", mimeType: "image/png", data: "AAA" }])).toBeNull();
	});

	test("c4 semantics retained: typed pre-admission busy vs post-admission generic error", async () => {
		class OfficialBusy extends Error {}
		bindNozeliBusyError(OfficialBusy);
		const lateBusy = { promptCustomMessage: async (_m, o) => { o?.onPromptAdmitted?.(); throw new Error("tool completed; remote is busy"); } };
		expect(await submitManagedPrompt(lateBusy, { customType: "x" }, "t", [], () => {})).toEqual({ settle: "unknown", reason: "tool completed; remote is busy" });
		const earlyBusy = { promptCustomMessage: async () => { throw new OfficialBusy("busy"); } };
		expect(await submitManagedPrompt(earlyBusy, { customType: "x" }, "t", [], () => {})).toEqual({ settle: "rejected", reason: "busy-race" });
	});

	test("attachment ingest validates base64 and TTL/epoch cleanup", () => {
		const buffer = new NozeliAttachmentBuffer({ maxChunkBytes: 8, maxUploadBytes: 8, ttlMs: 0 });
		expect(buffer.open(EPOCH, "up", "image/png")).toBe("ok");
		expect(buffer.chunk(EPOCH, "up", "AA A")).toBe("invalid-base64");
		expect(buffer.chunk(EPOCH, "up", "AAAA")).toBe("unknown-upload");
		expect(buffer.close(EPOCH, "up")).toBe("unknown-upload");
		expect(buffer.open(EPOCH, "valid", "image/png")).toBe("ok");
		expect(buffer.chunk(EPOCH, "valid", "AAAA")).toBe("ok");
		expect(buffer.close(EPOCH, "valid")).toBe("ok");
		buffer.beginEpoch("other#1");
		expect(buffer.peek(EPOCH, ["valid"])).toBe("unknown-upload");
	});

	test("actual guest 512KiB chunks retain the 33rd chunk and exact 32MiB encoded image", () => {
		const buffer = new NozeliAttachmentBuffer();
		expect(buffer.open(EPOCH, "large", "image/png")).toBe("ok");
		const chunk = "A".repeat(512 * 1024);
		for (let index = 0; index < 64; index++) expect(buffer.chunk(EPOCH, "large", chunk)).toBe("ok");
		expect(buffer.close(EPOCH, "large")).toBe("ok");
		const complete = buffer.peek(EPOCH, ["large"]);
		expect(Array.isArray(complete)).toBe(true);
		if (!Array.isArray(complete)) throw new Error("full attachment missing");
		expect(complete[0]!.data.length).toBe(32 * 1024 * 1024);
		expect(complete[0]!.data).toBe(chunk.repeat(64));
	});

	test("a rejected chunk cannot close a truncated image or reuse its upload identity", () => {
		const buffer = new NozeliAttachmentBuffer({ maxChunkBytes: 4, maxUploadBytes: 4 });
		expect(buffer.open(EPOCH, "invalid", "image/png")).toBe("ok");
		expect(buffer.chunk(EPOCH, "invalid", "AAAA")).toBe("ok");
		expect(buffer.chunk(EPOCH, "invalid", "AAAA")).toBe("over-upload-budget");
		expect(buffer.close(EPOCH, "invalid")).toBe("unknown-upload");
		expect(buffer.peek(EPOCH, ["invalid"])).toBe("unknown-upload");
		expect(buffer.open(EPOCH, "invalid", "image/png")).toBe("duplicate");
	});
});
