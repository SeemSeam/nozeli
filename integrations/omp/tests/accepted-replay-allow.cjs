// Fixture-only, synchronous adjudicator. Never used by production admission.
exports.admitAction = () => ({ decision: "allow" });
exports.readSnapshot = () => ({ grants: { "fixture-local-job": { jobId: "fixture-local-job" } } });
