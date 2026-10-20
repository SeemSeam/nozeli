#!/usr/bin/env bun
/**
 * P0 no-model collab smoke orchestrator v3 (executor round-2 hardening).
 * - Capability handoff via a 0600 file (NOZELI_LINK_FILE), never argv.
 * - TUI capture streams through a FIFO and is redacted BEFORE landing on disk.
 * - Every child: explicit minimal env, process-group tracked, TERM→KILL, and
 *   an exit barrier that awaits every tracked child's exit before process.exit.
 * - The managed room requires the host adjudicator seam; the smoke uses the
 *   hash-locked probes/smoke-adjudicator.cjs (deny-after-validation).
 *
 * Usage: node run-smoke.mjs <managed-omp-binary> <upstream-clone-dir> <evidence-dir>
 */
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { createHash } from "node:crypto";
import net from "node:net";
import { createStreamingRedactor } from "../src/nozeli-admission.ts";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

const [binary, clone, evidenceDir] = process.argv.slice(2);
if (!binary || !clone || !evidenceDir) throw new Error("usage: node run-smoke.mjs <binary> <clone> <evidence-dir>");
const unitRoot = path.resolve(import.meta.dirname, "..");
const adjudicator = path.join(unitRoot, "probes", "smoke-adjudicator.cjs");
const lock = JSON.parse(fs.readFileSync(path.join(unitRoot, "upstream.lock.json"), "utf8"));
const sha256 = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
if (sha256(adjudicator) !== lock.smoke.adjudicator_sha256) throw new Error("smoke adjudicator hash mismatch");
if (sha256(path.join(clone, lock.smoke.relay_script_pristine)) !== lock.smoke.relay_script_sha256) throw new Error("relay script hash mismatch");
fs.accessSync(binary, fs.constants.X_OK);

const BUN = spawnSync("bash", ["-c", "command -v bun"], { encoding: "utf8" }).stdout?.trim();
if (!BUN) throw new Error("bun not found on PATH");
{
	// Validate this build's manifest rather than historical binary hashes.
	const recipe = JSON.parse(fs.readFileSync(path.join(unitRoot, "private-runtime.lock.json"), "utf8"));
	const manifest = JSON.parse(fs.readFileSync(path.join(path.dirname(binary), "runtime.json"), "utf8"));
	if (sha256(binary) !== manifest.files?.omp) throw new Error("binary hash does not match runtime.json");
	for (const [key, expected] of Object.entries(recipe)) {
		if (!isDeepStrictEqual(manifest.provenance?.[key], expected)) throw new Error(`runtime provenance mismatch: ${key}`);
	}
	if (manifest.provenance.buildRecipeSha256 !== sha256(path.join(unitRoot, "build-private-runtime.mjs"))) throw new Error("runtime build recipe mismatch");
	for (const [file, expected] of [
		[path.join(unitRoot, "probes", "guest-probe.ts"), lock.smoke.guest_probe_sha256],
		[path.join(unitRoot, lock.smoke.adjudicator), lock.smoke.adjudicator_sha256],
	]) {
		if (sha256(file) !== expected) throw new Error(`smoke input hash mismatch: ${path.basename(file)}`);
	}
	const bunVersion = spawnSync(BUN, ["--version"], { encoding: "utf8" }).stdout?.trim();
	if (bunVersion !== recipe.toolchain) throw new Error(`bun ${bunVersion} != pinned ${recipe.toolchain}`);
}

const freePort = () =>
	new Promise((resolve, reject) => {
		const server = net.createServer();
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address();
			server.close(() => resolve(port));
		});
		server.on("error", reject);
	});
const waitPort = (port, ms) =>
	new Promise(resolve => {
		const socket = net.connect(port, "127.0.0.1");
		socket.on("connect", () => { socket.destroy(); resolve(true); });
		socket.on("error", () => { socket.destroy(); resolve(false); });
		setTimeout(() => { socket.destroy(); resolve(false); }, ms);
	});

const smokeRoot = fs.mkdtempSync("/tmp/nozeli-collab-p0-smoke-");
const home = path.join(smokeRoot, "home");
const project = path.join(smokeRoot, "project");
for (const dir of [home, project, path.join(home, "sessions"), path.join(home, "tmp"), evidenceDir]) fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(home, "models.yml"), "models:\n  - id: smoke-dummy/local\n    api: openai-completions\n    baseUrl: http://127.0.0.1:9/v1\n");

const shQuote = value => {
	if (!/^[A-Za-z0-9_./:=@-]+$/.test(value)) throw new Error(`unsafe argv element: ${JSON.stringify(value)}`);
	return value;
};

let exitProofMissing = false;
let redactorFinishFlush = () => {};
const children = new Map();
const track = (name, child) => {
	children.set(name, { child, exited: false });
	child.on("exit", (code, signal) => {
		const entry = children.get(name);
		if (entry) entry.exited = true;
		fs.appendFileSync(path.join(evidenceDir, "exit-proofs.txt"), `${new Date().toISOString()} ${name} pid=${child.pid} exit=${code ?? "null"} signal=${signal ?? "none"}\n`);
	});
	return child;
};
/** Exit barrier: teardown every owned process group and AWAIT proof of exit. */
const cleanup = async () => {
	for (const entry of children.values()) {
		if (entry.exited) continue;
		try { process.kill(-entry.child.pid, "SIGTERM"); } catch { /* gone */ }
	}
	await delay(1_000);
	for (const entry of children.values()) {
		if (entry.exited) continue;
		try { process.kill(-entry.child.pid, "SIGKILL"); } catch { /* gone */ }
	}
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline && [...children.values()].some(entry => !entry.exited)) await delay(100);
	for (const [name, entry] of children) {
		if (entry.exited) continue;
		fs.appendFileSync(path.join(evidenceDir, "exit-proofs.txt"), `${new Date().toISOString()} ${name} pid=${entry.child.pid} EXIT-PROOF-MISSING\n`);
		exitProofMissing = true; // a missing exit proof FAILS the run
	}
};

let exitCode = 3;
let verdict = "SMOKE-FAIL not-run";
let redactionPump = null;
try {
	const relayPort = await freePort();
	fs.writeFileSync(path.join(home, "config.yml"), `collab:\n  relayUrl: ws://127.0.0.1:${relayPort}\n  autoStart: control\nmodel: smoke-dummy/local\nsetupVersion: 2\n`);
	const relayLog = fs.openSync(path.join(evidenceDir, "relay.log"), "w");
	const relay = track("relay", spawn(BUN, [path.join(clone, "packages/collab-web/scripts/local-relay.ts"), "--port", String(relayPort)], { stdio: ["ignore", relayLog, relayLog], env: { PATH: "/usr/bin:/bin" }, detached: true }));
	let ready = false;
	for (let i = 0; i < 20 && !ready; i++) {
		await delay(250);
		ready = await waitPort(relayPort, 500);
	}
	if (!ready || relay.exitCode !== null) throw new Error(`relay not ready on :${relayPort} (exit=${relay.exitCode}); see evidence/relay.log`);

	const tuiEnvPairs = [
		"PATH=/usr/bin:/bin", `HOME=${home}`, `TMPDIR=${path.join(home, "tmp")}`, "TERM=xterm-256color",
		`PI_CODING_AGENT_DIR=${home}`, `PI_CONFIG_DIR=${home}`, `XDG_CONFIG_HOME=${path.join(home, ".config")}`,
		`XDG_DATA_HOME=${path.join(home, ".local/share")}`, `XDG_STATE_HOME=${path.join(home, ".local/state")}`,
		`XDG_CACHE_HOME=${path.join(home, ".cache")}`, "NOZELI_MANAGED_COLLAB=1",
		`NOZELI_ADMISSION_MODULE=${adjudicator}`,
	];
	const tuiArgv = ["env", "-i", ...tuiEnvPairs, binary, "--cwd", project, "--no-title", "--no-skills", "--session-dir", path.join(home, "sessions")].map(shQuote);

	// Stream the pty capture through a FIFO and redact before it lands.
	const fifo = path.join(smokeRoot, "capture.fifo");
	fs.mkdtempSync ? null : null;
	const { mkfifo } = await import("node:fs/promises").then(() => ({ mkfifo: null })).catch(() => ({ mkfifo: null }));
	spawnSync("mkfifo", [fifo]);
	const capturePath = path.join(evidenceDir, "tui-capture.log");
	fs.writeFileSync(capturePath, "", { mode: 0o600 });
	let buffer = "";
	redactionPump = fs.createReadStream(fifo);
	const redactor = createStreamingRedactor(/\/r\/[A-Za-z0-9_-]{10,64}\.[A-Za-z0-9_-]{20,}/g);
	let writeCapture = () => {};
	writeCapture = text => { if (text.length > 0) fs.appendFileSync(capturePath, text, "utf8"); };
	redactorFinishFlush = () => writeCapture(redactor.finish());
	redactionPump.on("data", chunk => {
		writeCapture(redactor.push(chunk.toString("latin1")));
	});
	redactionPump.on("end", () => {
		writeCapture(redactor.finish());
	});
	redactionPump.on("error", () => {
		writeCapture(redactor.finish());
	});

	// stdin stays an open, never-written pipe: no EOF reaches the pty and no
	// input is injected; the parent holds the write end for the run's lifetime.
	const tui = track("tui", spawn("script", ["-q", "-f", "-c", tuiArgv.join(" "), fifo], { stdio: ["pipe", "ignore", "ignore"], env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" }, detached: true }));
	tui.stdin?.on?.("error", () => {});
	let link = null;
	let listing = "";
	const cliEnv = [...tuiEnvPairs.filter(pair => !pair.startsWith("NOZELI_"))];
	const runCli = args => spawnSync("env", ["-i", ...cliEnv, binary, ...args], { encoding: "utf8", timeout: 20000 });
	for (let waited = 0; waited < 30000 && !link; waited += 1000) {
		await delay(1000);
		listing = runCli(["collab", "list"]).stdout ?? "";
		const pid = listing.match(/pid (\d+)/)?.[1];
		if (!pid) continue;
		const linkOut = runCli(["collab", "link", pid]).stdout ?? "";
		link = linkOut.match(/ws:\/\/[^\s]+/)?.[0] ?? null;
	}
	fs.writeFileSync(path.join(evidenceDir, "room-facts.txt"), `${new Date().toISOString()} port=${relayPort} binarySha256=${sha256(binary)} adjudicatorSha256=${lock.smoke.adjudicator_sha256}\n${listing}\n`);
	if (!link) throw new Error("no live collab room/link via registry within 30s");

	// Capability handoff: 0600 file consumed by the probe, never argv.
	const linkFile = path.join(smokeRoot, "link.txt");
	fs.writeFileSync(linkFile, link, { mode: 0o600 });
	console.log(`link handed off via 0600 file (redacted): ws://127.0.0.1:${relayPort}/r/***`);

	const probeLog = fs.openSync(path.join(evidenceDir, "guest-probe.log"), "w");
	const probe = track("probe", spawn(BUN, [path.join(import.meta.dirname, "guest-probe.ts")], {
		stdio: ["ignore", probeLog, probeLog],
        env: { PATH: path.dirname(BUN) + path.delimiter + '/usr/bin:/bin', UPSTREAM_CLONE: clone, NOZELI_LINK_FILE: linkFile },
	}));
	const probeCode = await new Promise(resolve => probe.on("exit", resolve));
	fs.closeSync(probeLog);
	exitCode = probeCode === 0 ? 0 : 3;
	verdict = probeCode === 0 ? "SMOKE-PASS" : `SMOKE-FAIL probe exit ${probeCode}`;
} catch (error) {
	verdict = `SMOKE-FAIL ${String(error.message ?? error)}`;
	exitCode = 2;
} finally {
	await cleanup(); // TERM→KILL + await every owned child's exit proof
	if (exitProofMissing) exitCode = Math.max(exitCode, 2);
	if (redactionPump) {
		// Flush the FIFO and finish the redactor synchronously — no stream
		// finish-await that could hang teardown; finish() is idempotent-safe.
		try { redactionPump.destroy(); } catch { /* already gone */ }
		redactorFinishFlush();
	}
	// The ONLY final verdict line, after teardown + redaction + capture flush.
	console.log(exitProofMissing ? `SMOKE-FAIL exit-proof-missing (${verdict})` : verdict);
	console.log(`smoke root: ${smokeRoot}`);
}
process.exit(exitCode);
