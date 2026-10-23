function plainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function normalizedDiagnostic(diagnostic) {
  const message = String(diagnostic?.message || 'Archify could not classify this failure.').trim();
  return {
    code: String(diagnostic?.code || 'internal/unclassified'),
    severity: diagnostic?.severity === 'warning' ? 'warning' : 'error',
    message,
    subject: plainObject(diagnostic?.subject),
    evidence: plainObject(diagnostic?.evidence),
    supportedFixes: Array.isArray(diagnostic?.supportedFixes)
      ? [...new Set(diagnostic.supportedFixes.map((fix) => String(fix).trim()).filter(Boolean))]
      : [],
  };
}

// CLI recording becomes a value, never a process-global accumulator.
export function recordDiagnostic(diagnostic) { return normalizedDiagnostic(diagnostic); }

export function throwDiagnosticError(message, diagnostics) {
  const error = new Error(message);
  error.archifyDiagnostics = (diagnostics || []).map(normalizedDiagnostic);
  throw error;
}

export function throwDiagnosticProblems(prefix, problems, { code = 'layout/constraint', subject = {} } = {}) {
  const messages = (problems || []).map((problem) => String(problem));
  throwDiagnosticError(`${prefix}:\n- ${messages.join('\n- ')}`, messages.map((message) => ({code, severity: 'error', message, subject})));
}

