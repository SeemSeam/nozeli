import { describe, expect, test } from "bun:test";
import {
	createNozeliAdmission,
	NozeliAttachmentBuffer,
	nozeliContentDigest,
	nozeliInlineDigests,
	nozeliPayloadDescriptor,
} from "../src/nozeli-admission.ts";

const epoch = "descriptor-session#0";
const png = { type: "image", mimeType: "image/png", data: "AAAA" };
const jpeg = { type: "image", mimeType: "image/jpeg", data: "BBBB" };

function acceptedRefs() {
	const uploads = new NozeliAttachmentBuffer({ maxUploads: 4 });
	for (const [up, image] of [["ref-png", png], ["ref-jpeg", jpeg]] as const) {
		expect(uploads.open(epoch, up, image.mimeType)).toBe("ok");
		expect(uploads.chunk(epoch, up, image.data)).toBe("ok");
		expect(uploads.close(epoch, up)).toBe("ok");
	}
	const images = uploads.peek(epoch, ["ref-png", "ref-jpeg"]);
	const metadata = uploads.describe(epoch, ["ref-png", "ref-jpeg"]);
	if (!Array.isArray(images) || !Array.isArray(metadata)) throw Error("fixture upload invalid");
	const digest = nozeliContentDigest(epoch, "prompt", "original", images);
	if (!digest) throw Error("fixture digest invalid");
	const descriptor = nozeliPayloadDescriptor("original", metadata, digest);
	const gate = createNozeliAdmission({ admitAction: () => ({ decision: "allow" }) }, 1);
	gate.beginEpoch(epoch);
	const envelope = { kind: "prompt" as const, rid: "descriptor-rid-01", dg: digest, at: 1, ep: epoch, ar: "job-1", canWrite: true, busy: false };
	expect(gate.admit(envelope).decision).toBe("reserved");
	expect(gate.confirm(envelope.rid, digest, digest, descriptor)).toBeNull();
	expect(gate.adjudicate(envelope.rid)).toBeNull();
	gate.beginDispatch(envelope.rid);
	gate.markAdmitted(envelope.rid);
	gate.onTurnStart();
	uploads.commit(epoch, ["ref-png", "ref-jpeg"]);
	gate.onTurnEnd();
	return { gate, uploads, envelope, descriptor };
}

describe("retained immutable payload proof (executor round7)", () => {
	test("exact committed-ref replay succeeds without live bytes; old dg cannot authorize text/ref/order substitutions", () => {
		const { gate, uploads, envelope, descriptor } = acceptedRefs();
		expect(uploads.peek(epoch, ["ref-png", "ref-jpeg"])).toBe("unknown-upload");
		expect(gate.admit(envelope).decision).toBe("replay");
		expect(gate.verifyReplay(envelope.rid, { textDigest: descriptor.textDigest, refNames: ["ref-png", "ref-jpeg"], inlineDigests: [] })).toEqual({ ok: true });
		const changed = nozeliPayloadDescriptor("changed", [], descriptor.canonicalDigest);
		expect(gate.verifyReplay(envelope.rid, { textDigest: changed.textDigest, refNames: ["ref-png", "ref-jpeg"], inlineDigests: [] })).toEqual({ ok: false, reason: "text-changed" });
		for (const refs of [["different", "ref-jpeg"], ["ref-jpeg", "ref-png"], ["ref-png"]]) {
			expect(gate.verifyReplay(envelope.rid, { textDigest: descriptor.textDigest, refNames: refs, inlineDigests: [] })).toEqual({ ok: false, reason: "refs-changed" });
		}
		expect(gate.admit(envelope).receipt.status).toBe("admitted");
	});

	test("committed upload ID cannot be reused for different MIME or bytes; tombstones remain bounded", () => {
		const { uploads } = acceptedRefs();
		expect(uploads.open(epoch, "ref-png", "image/jpeg")).toBe("duplicate");
		expect(uploads.chunk(epoch, "ref-png", "CCCC")).toBe("unknown-upload");
		expect(uploads.open(epoch, "third", "image/png")).toBe("ok");
		expect(uploads.open(epoch, "fourth", "image/png")).toBe("ok");
		expect(uploads.open(epoch, "fifth", "image/png")).toBe("over-upload-count");
		expect(uploads.open(epoch, "ref-jpeg", "image/png")).toBe("duplicate");
	});

	test("inline replay verifies actual ordered MIME/data digests, not an old declared dg", () => {
		const gate = createNozeliAdmission({ admitAction: () => ({ decision: "allow" }) });
		gate.beginEpoch(epoch);
		const dg = nozeliContentDigest(epoch, "prompt", "inline", [png, jpeg]);
		if (!dg) throw Error("fixture digest invalid");
		const rid = "inline-payload-01";
		gate.admit({ kind: "prompt", rid, dg, at: 1, ep: epoch, ar: "job-1", canWrite: true, busy: false });
		const descriptor = nozeliPayloadDescriptor("inline", [], dg, [png, jpeg]);
		gate.confirm(rid, dg, dg, descriptor);
		const base = { textDigest: descriptor.textDigest, refNames: [] };
		expect(gate.verifyReplay(rid, { ...base, inlineDigests: nozeliInlineDigests([png, jpeg]) })).toEqual({ ok: true });
		for (const images of [[{ ...png, data: "CCCC" }, jpeg], [{ ...png, mimeType: "image/jpeg" }, jpeg], [jpeg, png], []]) {
			expect(gate.verifyReplay(rid, { ...base, inlineDigests: nozeliInlineDigests(images) })).toEqual({ ok: false, reason: "inline-changed" });
		}
	});

	test("abort replay verifies actual cancellation target even when dg and envelope are unchanged", () => {
		const { gate, envelope } = acceptedRefs();
		gate.onTurnStart(); // native/manual turn; no guessed managed owner
		const rid = "abort-descriptor-01";
		const dg = nozeliContentDigest(epoch, "abort", "", [], "*");
		if (!dg) throw Error("fixture digest invalid");
		expect(gate.admit({ kind: "abort", rid, dg, at: 2, ep: epoch, ar: envelope.ar, tr: "*", canWrite: true, busy: true }).decision).toBe("reserved");
		const descriptor = nozeliPayloadDescriptor("", [], dg, [], "*");
		gate.confirm(rid, dg, dg, descriptor);
		gate.settle(rid, "executed");
		const probe = { textDigest: descriptor.textDigest, refNames: [], inlineDigests: [] };
		expect(gate.verifyReplay(rid, { ...probe, target: "*" })).toEqual({ ok: true });
		expect(gate.verifyReplay(rid, { ...probe, target: "old-managed-rid" })).toEqual({ ok: false, reason: "target-changed" });
	});

	test("missing descriptor proof rejects instead of bypassing verification", () => {
		const gate = createNozeliAdmission({ admitAction: () => ({ decision: "allow" }) });
		gate.beginEpoch(epoch);
		expect(gate.verifyReplay("no-descriptor-rid", { textDigest: "x", refNames: [], inlineDigests: [] })).toEqual({ ok: false, reason: "unverifiable-no-descriptor" });
	});
});
