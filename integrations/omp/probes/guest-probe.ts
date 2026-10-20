/**
 * P0 negative-probe guest v3 (bun). Capability handoff: the room link is read
 * from a 0600 file whose path comes via NOZELI_LINK_FILE (never argv).
 * Asserts the dispatch-layer contract on the wire, including a POSITIVE
 * chunked-upload full-payload reconstruction (digest match) that is then
 * denied by the smoke adjudicator — proving transport+digest without any
 * model surface.
 *
 * Usage: UPSTREAM_CLONE=<clone> NOZELI_LINK_FILE=<0600 file> bun guest-probe.ts
 */
const CLONE = process.env.UPSTREAM_CLONE;
if (!CLONE) throw new Error("UPSTREAM_CLONE must point at the pinned upstream clone");
const linkFile = process.env.NOZELI_LINK_FILE;
if (!linkFile) throw new Error("NOZELI_LINK_FILE must carry the 0600 link file path");
const { readFile, rm } = await import("node:fs/promises");
const link = (await readFile(linkFile, "utf8")).trim();
await rm(linkFile, { force: true }); // capability consumed once

const { importRoomKey } = await import(`${CLONE}/packages/coding-agent/src/collab/crypto.ts`);
const { COLLAB_PROTO, parseCollabLink } = await import(`${CLONE}/packages/coding-agent/src/collab/protocol.ts`);
const { CollabSocket } = await import(`${CLONE}/packages/coding-agent/src/collab/relay-client.ts`);
const { nozeliContentDigest } = await import("../src/nozeli-admission.ts");

interface WelcomeFrame {
	t: "welcome";
	nozeli?: { managedCollab?: number; admissionRef?: string; epoch?: string };
}
type AnyFrame = { t: string; [key: string]: unknown };
interface ReceiptTrail {
	status: string;
	reason?: string;
	seq: number;
	kind: string;
}

const parsed = parseCollabLink(link);
if ("error" in parsed) throw new Error(parsed.error);
if (!parsed.writeToken) throw new Error("probe needs the full (write) link");
const key = await importRoomKey(parsed.key);

const results: Array<{ check: string; ok: boolean; detail: unknown }> = [];
const record = (check: string, ok: boolean, detail: unknown = null): void => {
	results.push({ check, ok, detail });
	console.log(`${ok ? "PASS" : "FAIL"} ${check}${detail === null ? "" : ` :: ${JSON.stringify(detail).slice(0, 180)}`}`);
};

const receipts = new Map<string, ReceiptTrail[]>();
const errors: string[] = [];
let welcome: WelcomeFrame | null = null;
let snapshotDone = false;
let epoch = "";

const socket = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key });
socket.onFrame = (frame: AnyFrame): void => {
	if (frame.t === "welcome") {
		welcome = frame as WelcomeFrame;
		epoch = (frame as WelcomeFrame).nozeli?.epoch ?? "";
	} else if (frame.t === "snapshot-chunk" && frame.final === true) snapshotDone = true;
	else if (frame.t === "action-receipt") {
		const rid = String(frame.rid);
		const list = receipts.get(rid) ?? [];
		list.push({ status: String(frame.status), reason: frame.reason === undefined ? undefined : String(frame.reason), seq: Number(frame.seq), kind: String(frame.kind) });
		receipts.set(rid, list);
	} else if (frame.t === "error") errors.push(String(frame.message));
};
socket.onOpen = (): void => {
	socket.send({ t: "hello", proto: COLLAB_PROTO, name: "nozeli-p0-probe", writeToken: Buffer.from(parsed.writeToken!).toString("base64url") });
};
socket.connect();

const waitFor = async (probe: () => boolean, ms: number, what: string): Promise<boolean> => {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (probe()) return true;
		await Bun.sleep(100);
	}
	record(`timeout waiting for ${what}`, false);
	return false;
};
const anyReceipt = (predicate: (trail: ReceiptTrail) => boolean): boolean =>
	[...receipts.values()].some(list => list.some(predicate));
const trailOf = (rid: string): ReceiptTrail[] => receipts.get(rid) ?? [];

await waitFor(() => welcome !== null, 15000, "welcome");
record("welcome received", welcome !== null);
record("managed capability + epoch advertised", welcome?.nozeli?.managedCollab === 1 && epoch.length > 0, welcome?.nozeli ? { epochTail: epoch.slice(-6) } : null);
await waitFor(() => snapshotDone, 20000, "snapshot final chunk");
record("snapshot replicated (final chunk)", snapshotDone);

// (a) id-less legacy frames rejected at the dispatch layer.
socket.send({ t: "prompt", text: "id-less (never admitted)" });
await waitFor(() => anyReceipt(t => t.reason === "no-request-id"), 8000, "no-request-id");
record("id-less prompt rejected", anyReceipt(t => t.kind === "prompt" && t.reason === "no-request-id"));
socket.send({ t: "abort" });
await waitFor(() => anyReceipt(t => t.kind === "abort" && t.reason === "no-request-id"), 8000, "abort no-request-id");
record("id-less abort rejected", anyReceipt(t => t.kind === "abort" && t.reason === "no-request-id"));

// (b) disabled controls in managed rooms.
socket.send({ t: "agent-cmd", cmd: "chat", agentId: "x", text: "y" });
socket.send({ t: "ui-response", reqId: 1 });
await waitFor(() => errors.some(m => m.includes("agent control is disabled")) && errors.some(m => m.includes("UI responses are disabled")), 8000, "disabled controls");
record("agent-cmd disabled", errors.some(m => m.includes("agent control is disabled in a Nozeli-managed room")));
record("ui-response disabled", errors.some(m => m.includes("UI responses are disabled in a Nozeli-managed room")));

// (c) POSITIVE synthetic transport payload: 6,200,256 encoded base64 bytes
// (4,650,192 decoded bytes), 7 chunks <=1MiB; exact accounting is recorded
// in evidence/payload-size-accounting.json. The prompt digest binds the
// canonical payload — validated by the host, then DENIED by the smoke
// adjudicator. Proves chunk transport + structured digest with zero model.
const chunkSize = 1_048_576;
const imageA = "A".repeat(6_200_000);
const imageB = "B".repeat(256);
for (const [up, mime, data] of [["up-a", "image/png", imageA], ["up-b", "image/jpeg", imageB]] as const) {
	socket.send({ t: "attach-open", up, ep: epoch, mime });
	for (let offset = 0; offset < data.length; offset += chunkSize) {
		socket.send({ t: "attach-chunk", up, ep: epoch, data: data.slice(offset, offset + chunkSize) });
	}
	socket.send({ t: "attach-close", up, ep: epoch });
}
const reconstructed = [
	{ type: "image", mimeType: "image/png", data: imageA },
	{ type: "image", mimeType: "image/jpeg", data: imageB },
];
const fullDg = nozeliContentDigest(epoch, "prompt", "two-image budget probe", reconstructed);
if (fullDg === null) throw new Error("canonical digest failed on reconstructed payload");
socket.send({ t: "prompt", text: "two-image budget probe", rid: "probe-full-0001", dg: fullDg, at: 1, ep: epoch, ar: "job-smoke-1", refs: ["up-a", "up-b"] });
await waitFor(() => trailOf("probe-full-0001").length > 0, 20000, "full-payload adjudication");
record(
	"chunked full-payload digest validated then adjudicator-denied (no model)",
	trailOf("probe-full-0001").some(t => t.status === "rejected" && t.reason === "not-authorized:smoke-no-model:prompt"),
	trailOf("probe-full-0001").map(t => ({ status: t.status, reason: t.reason })),
);

// (d) digest mismatch (wrong dg over the same uploaded refs) is explicit.
socket.send({ t: "prompt", text: "two-image budget probe", rid: "probe-mm-00001", dg: "0".repeat(64), at: 2, ep: epoch, ar: "job-smoke-1", refs: [] });
await waitFor(() => trailOf("probe-mm-00001").length > 0, 8000, "mismatch");
record("digest mismatch rejected explicitly", trailOf("probe-mm-00001").some(t => t.reason === "digest-mismatch"));

// (e) abort target binding: '*' with no active turn is rejected (idle room).
const starDg = nozeliContentDigest(epoch, "abort", "", [], "*");
socket.send({ t: "abort", rid: "probe-abort-star", dg: starDg, at: 3, ep: epoch, ar: "job-smoke-1", tr: "*" });
await waitFor(() => trailOf("probe-abort-star").length > 0, 8000, "no-active-turn");
record("abort '*' without an active turn rejected", trailOf("probe-abort-star").some(t => t.reason === "no-active-turn"));

// (f) action-query is a pure lookup.
socket.send({ t: "action-query", rid: "probe-full-0001", ep: epoch });
socket.send({ t: "action-query", rid: "probe-never-seen", ep: epoch });
await waitFor(() => errors.some(m => m.includes("forgotten")), 8000, "forgotten query");
const factsBefore = trailOf("probe-full-0001").length;
await Bun.sleep(300);
record("action-query answers without mutating", errors.some(m => m.includes("action-query: receipt forgotten")) && trailOf("probe-full-0001").length === factsBefore);

// (g) read-only link (no write token): a fully valid request is still rejected.
const roSocket = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key });
let roWelcome: WelcomeFrame | null = null;
const roReceipts: ReceiptTrail[] = [];
roSocket.onFrame = (frame: AnyFrame): void => {
	if (frame.t === "welcome") roWelcome = frame as WelcomeFrame;
	else if (frame.t === "action-receipt") roReceipts.push({ status: String(frame.status), reason: frame.reason === undefined ? undefined : String(frame.reason), seq: Number(frame.seq), kind: String(frame.kind) });
};
roSocket.onOpen = (): void => {
	roSocket.send({ t: "hello", proto: COLLAB_PROTO, name: "nozeli-ro-probe" });
};
roSocket.connect();
await waitFor(() => roWelcome !== null, 12000, "read-only welcome");
const roDg = nozeliContentDigest(epoch, "prompt", "read-only probe");
socket.close();
roSocket.send({ t: "prompt", text: "read-only probe", rid: "probe-ro-0001", dg: roDg, at: 900, ep: epoch, ar: "job-smoke-1" });
await waitFor(() => roReceipts.length > 0, 8000, "read-only rejection");
record("read-only (no token) valid request rejected", roReceipts.some(t => t.reason === "read-only"));
roSocket.close();

const failed = results.filter(r => !r.ok);
console.log(`\nprobe summary: ${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) {
	console.log(JSON.stringify(failed, null, 1));
	process.exit(1);
}
process.exit(0);
