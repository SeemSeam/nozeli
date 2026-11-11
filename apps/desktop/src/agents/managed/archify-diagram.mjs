import { createHash } from 'node:crypto';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { renderDiagram as architecture } from './archify-vendor/renderers/architecture/render-architecture.mjs';
import { renderDiagram as workflow } from './archify-vendor/renderers/workflow/render-workflow.mjs';
import { renderDiagram as sequence } from './archify-vendor/renderers/sequence/render-sequence.mjs';
import { renderDiagram as dataflow } from './archify-vendor/renderers/dataflow/render-dataflow.mjs';
import { renderDiagram as lifecycle } from './archify-vendor/renderers/lifecycle/render-lifecycle.mjs';
import { validateSchema } from './archify-vendor/renderers/shared/validator.mjs';
import { validateGuidedViews, validateRelationshipIds } from './archify-vendor/renderers/shared/cli.mjs';
import { validateEngineeringProfile } from './archify-vendor/renderers/shared/engineering-profiles.mjs';
import { prepareDiagramBrandMarks } from './archify-vendor/renderers/shared/brand-marks.mjs';
import { checkRenderOutput } from './archify-vendor/scripts/check-render-output.mjs';
import { STATIC_STYLE } from './archify-vendor/static-style.mjs';
import { ARCHIFY_LICENSE, ICON_LICENSE } from './archify-vendor/notices.mjs';
import { GENERATOR_DIGEST } from './archify-vendor/generator-identity.mjs';

const renderers = { architecture, workflow, sequence, dataflow, lifecycle };
const collections = { architecture: ['components', 'connections'], workflow: ['nodes', 'edges'], sequence: ['participants', 'messages'], dataflow: ['nodes', 'flows'], lifecycle: ['states', 'transitions'] };
const hash = value => createHash('sha256').update(value).digest('hex');

// Known, correctable diagram-input failures carry this stable code so the
// controller can return them to the originating Worker as a retryable tool
// result instead of routing the turn to maintenance. Everything else —
// TypeError, malformed renderer output, internal invariants — stays an
// unexpected failure and is never reclassified or swallowed here.
export const DIAGRAM_INPUT_INVALID = 'DIAGRAM_INPUT_INVALID';

// Closed vocabulary: rule-family prefix -> reported validation category.
const RULE_CATEGORY = new Map([
  ['schema', 'schema'], ['layout', 'layout'], ['clean-flow', 'layout'], ['composition', 'layout'], ['legend', 'layout'],
  ['guided-view', 'guided-view'], ['relationship', 'relationship'], ['engineering', 'engineering-profile'],
  ['brand', 'brand'], ['type', 'type'], ['spec', 'spec'], ['policy', 'policy'],
  ['render-output', 'render-output'], ['output', 'output-size'],
]);

// Rule codes must come from the closed vendor/adapter vocabularies (for example
// "schema/required", "clean-flow/endpoint-side-direction"). The pattern admits
// no spaces, quotes or user text, so a code can never leak a label.
function safeRuleCode(value) {
  const code = String(value ?? '').trim();
  return /^[a-z0-9][a-z0-9_-]*(?:\/[a-z0-9][a-z0-9_-]*)*$/.test(code) ? code : 'internal/unclassified';
}

function ruleCounts(codes) {
  const counts = new Map();
  for (const code of codes) counts.set(code, (counts.get(code) || 0) + 1);
  return [...counts.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([code, count]) => ({ code, count }));
}

// Machine evidence for ledgers/diagnostics: tool, stage, effect, category and
// rule-code histogram only. Raw labels and document text stay out by design;
// the human-readable message on the error is the Worker-facing channel.
// `correction` additionally carries the vendor's supported fixes for the
// originating Worker; those may echo spec-authored ids the Worker itself wrote,
// so they belong to the Worker reply, never to a ledger.
function typedDiagramError(error, category, codes, supportedFixes) {
  const rules = ruleCounts(codes.map(safeRuleCode));
  error.code = DIAGRAM_INPUT_INVALID;
  error.diagramEvidence = { tool: 'nozeli_diagram', stage: 'validation', effect: 'none', category, rules };
  error.correction = { retryTool: 'nozeli_diagram', category, rules, supportedFixes };
  return error;
}

function diagramInputError(message, category, codes) {
  return typedDiagramError(new Error(message), category, codes, []);
}

// Classification boundary for vendor failures: every renderer/validator error
// raised through the vendor diagnostics channel carries `archifyDiagnostics`.
// Those describe what the author must fix, so they become typed input errors.
// Geometry diagnostics carry their specific rule only as a bracketed message
// prefix, which the safe-code pattern extracts without keeping any label text.
export function classifyDiagramFailure(error) {
  if (!error || typeof error !== 'object') return error;
  if (error.code === DIAGRAM_INPUT_INVALID) return error;
  if (!Array.isArray(error.archifyDiagnostics)) return error;
  const codes = error.archifyDiagnostics.map(entry => {
    const inline = String(entry?.message || '').match(/^\[([a-z0-9_-]+(?:\/[a-z0-9_-]+)+)\]/);
    return inline ? inline[1] : entry?.code;
  });
  const category = codes.length ? (RULE_CATEGORY.get(String(codes[0]).split('/')[0]) || 'validation') : 'validation';
  const supportedFixes = [...new Set(error.archifyDiagnostics.flatMap(entry => (Array.isArray(entry?.supportedFixes) ? entry.supportedFixes : []).map(fix => String(fix))).filter(Boolean))];
  return typedDiagramError(error, category, codes, supportedFixes);
}

export function canonicalDiagramSpec(value) {
  let nodes = 0;
  function visit(item, depth) {
    if (++nodes > 30_000 || depth > 64) throw diagramInputError('Diagram specification complexity budget exceeded', 'spec', ['spec/complexity-budget']);
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return JSON.stringify(item);
    if (typeof item === 'number' && Number.isFinite(item)) return JSON.stringify(item);
    if (Array.isArray(item)) return '[' + item.map(child => visit(child, depth + 1)).join(',') + ']';
    if (item && typeof item === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(item))) {
      return '{' + Object.keys(item).sort().map(key => JSON.stringify(key) + ':' + visit(item[key], depth + 1)).join(',') + '}';
    }
    throw diagramInputError('Diagram specification must contain only finite JSON values', 'spec', ['spec/non-finite-json']);
  }
  const text = visit(value, 0) + '\n';
  if (Buffer.byteLength(text) > 1024 * 1024) throw diagramInputError('Diagram specification exceeds 1 MiB', 'spec', ['spec/size-limit']);
  return text;
}

function canonicalSvg(raw, spec, description, hasBrands) {
  const doc = new DOMParser({ onError: () => { throw new Error('Archify produced malformed SVG'); } }).parseFromString(raw.replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" '), 'image/svg+xml');
  const root = doc.documentElement;
  function strip(node) {
    if (node.nodeType !== 1) return;
    for (const attr of Array.from(node.attributes)) {
      if (attr.name.startsWith('data-') || ['tabindex', 'aria-pressed', 'aria-expanded'].includes(attr.name)) node.removeAttribute(attr.name);
    }
    if (node !== root && node.getAttribute('role') === 'button') node.setAttribute('role', 'group');
    for (const child of Array.from(node.childNodes)) strip(child);
  }
  strip(root);
  root.setAttribute('class', 'preset-' + (spec.meta.visual_preset || 'classic'));
  root.getElementsByTagName('desc')[0].textContent = description;
  const license = doc.createComment('\n' + ARCHIFY_LICENSE + (hasBrands ? '\nSimple Icons 16.28.0; trademark rights remain with their owners.\n' + ICON_LICENSE : '') + '\n');
  root.insertBefore(license, root.firstChild);
  const style = doc.createElementNS('http://www.w3.org/2000/svg', 'style');
  style.textContent = STATIC_STYLE;
  root.insertBefore(style, root.firstChild);
  return new XMLSerializer().serializeToString(root) + '\n';
}

/** Offline, reentrant rendering. No filesystem writes, subprocess, network or runtime npm. */
export async function renderArchifyDiagram(options) {
  try {
    return await renderDiagram(options);
  } catch (error) {
    // Only vendor diagnostics-channel failures gain the typed code here; every
    // other error (adapter admission throws its own typed errors above) is
    // returned untouched so genuine internal failures stay failures.
    throw classifyDiagramFailure(error);
  }
}

async function renderDiagram({ type, spec } = {}) {
  if (!Object.hasOwn(renderers, type)) throw diagramInputError('Unsupported Archify diagram type', 'type', ['type/unsupported']);
  const specText = canonicalDiagramSpec(spec);
  const diagram = JSON.parse(specText);
  validateSchema(type, diagram);
  if (diagram.diagram_type !== type) throw diagramInputError('Diagram type does not match specification', 'type', ['type/mismatch']);
  // Repository claims cannot be verified by a pure renderer; cite host-frozen sources in HTML instead.
  if (diagram.meta.repository || diagram.components?.some(node => node.sources?.length)) throw diagramInputError('Repository evidence requires host-frozen report references; embedded unverified repository claims are unsupported', 'policy', ['policy/repository-evidence']);
  validateGuidedViews(type, diagram);
  validateRelationshipIds(type, diagram);
  validateEngineeringProfile(type, diagram);
  prepareDiagramBrandMarks(type, diagram);
  const raw = renderers[type](diagram);
  const validation = checkRenderOutput(raw);
  validation.visualReview = 'pending';
  if (!validation.ok) {
    const failed = validation.checks.filter(check => !check.ok);
    const error = diagramInputError('Archify render validation failed: ' + failed.map(check => check.name + ': ' + check.details.join('; ')).join('\n'), 'render-output', failed.map(check => 'render-output/' + check.name));
    error.validation = validation;
    throw error;
  }
  const [nodeKey, edgeKey] = collections[type];
  const labels = new Map(diagram[nodeKey].map(node => [node.id, node.label]));
  const relationships = (diagram[edgeKey] || []).map(edge => `${labels.get(edge.from) || edge.from} → ${labels.get(edge.to) || edge.to}${edge.label ? ': ' + edge.label : ''}`);
  const alt = `${diagram.meta.title}. ${[...labels.values()].join('; ')}.${relationships.length ? ' ' + relationships.join('; ') + '.' : ''}`;
  const svg = canonicalSvg(raw, diagram, alt, diagram[nodeKey].some(node => node.brand));
  if (Buffer.byteLength(svg) > 8 * 1024 * 1024) throw diagramInputError('Rendered diagram exceeds 8 MiB', 'output-size', ['output/size-limit']);
  return { svg, spec: JSON.parse(specText), specText, specDigest: hash(specText), generatorDigest: GENERATOR_DIGEST, validation, alt, caption: diagram.meta.subtitle || diagram.meta.title };
}
