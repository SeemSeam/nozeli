import { AgentError } from './runtime.mjs';

const forbidden = new Set(['command', 'args', 'argv', 'cwd', 'shell', 'env', 'executable', 'path', 'bin']);

function payload(input, allowed) {
  const body = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  for (const key of Object.keys(body)) {
    if (forbidden.has(key) || !allowed.includes(key)) {
      throw new AgentError('INVALID_PAYLOAD', 'Renderer cannot supply executable paths or shell arguments.');
    }
  }
  return body;
}

export function agentOps(runtime) {
  return {
    'agents.status': (input) => runtime.status(payload(input, ['projectId']).projectId),
    'agents.console': (input) => runtime.console(payload(input, ['projectId']).projectId),
    'agents.messages': async (input) => { const {projectId} = payload(input, ['projectId']); await runtime.loadHistory(projectId); return {messages:runtime.messages(projectId)}; },
    'agents.work': async (input) => { const {projectId} = payload(input, ['projectId']); await runtime.loadHistory(projectId); return {work:runtime.work(projectId)}; },
    'agents.reports': async (input) => { const {projectId} = payload(input, ['projectId']); await runtime.loadHistory(projectId); return {reports:runtime.reports(projectId)}; },
    'agents.report.read': (input) => {
      const body = payload(input, ['projectId', 'reportId']);
      return runtime.readReport(body.projectId, body.reportId);
    },
  };
}
