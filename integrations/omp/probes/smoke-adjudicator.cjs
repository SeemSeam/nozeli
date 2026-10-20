/**
 * Smoke adjudicator (CommonJS — loaded via createRequire by the host patch).
 * Prompts are denied AFTER full structural/digest validation so the no-model
 * smoke proves complete payload reconstruction without admitting a prompt.
 * Aborts flow through to the ownership rules. The grant context received here
 * carries the actual computed content digest, attempt, and turn target — the
 * P1 Controller seam answers with the same shape over a refreshed grant table.
 */
exports.admitAction = function admitAction(request) {
	if (request.kind === "abort") return { decision: "allow" };
	return { decision: "deny", reason: `smoke-no-model:${request.kind}` };
};
