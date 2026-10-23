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

// This byte representation is also returned for the host to freeze as the spec artifact.
// JSON-only input keeps digests stable across process/platform and rejects lossy coercions.
export function canonicalDiagramSpec(value) {
  let nodes = 0;
  function visit(item, depth) {
    if (++nodes > 30_000 || depth > 64) throw new Error('Diagram specification complexity budget exceeded');
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return JSON.stringify(item);
    if (typeof item === 'number' && Number.isFinite(item)) return JSON.stringify(item);
    if (Array.isArray(item)) return '[' + item.map(child => visit(child, depth + 1)).join(',') + ']';
    if (item && typeof item === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(item))) {
      return '{' + Object.keys(item).sort().map(key => JSON.stringify(key) + ':' + visit(item[key], depth + 1)).join(',') + '}';
    }
    throw new Error('Diagram specification must contain only finite JSON values');
  }
  const text = visit(value, 0) + '\n';
  if (Buffer.byteLength(text) > 1024 * 1024) throw new Error('Diagram specification exceeds 1 MiB');
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
export async function renderArchifyDiagram({ type, spec } = {}) {
  if (!Object.hasOwn(renderers, type)) throw new Error('Unsupported Archify diagram type');
  const specText = canonicalDiagramSpec(spec);
  const diagram = JSON.parse(specText);
  validateSchema(type, diagram);
  if (diagram.diagram_type !== type) throw new Error('Diagram type does not match specification');
  // Repository claims cannot be verified by a pure renderer; cite host-frozen sources in HTML instead.
  if (diagram.meta.repository || diagram.components?.some(node => node.sources?.length)) throw new Error('Repository evidence requires host-frozen report references; embedded unverified repository claims are unsupported');
  validateGuidedViews(type, diagram);
  validateRelationshipIds(type, diagram);
  validateEngineeringProfile(type, diagram);
  prepareDiagramBrandMarks(type, diagram);
  const raw = renderers[type](diagram);
  const validation = checkRenderOutput(raw);
  validation.visualReview = 'pending';
  if (!validation.ok) {
    const error = new Error('Archify render validation failed: ' + validation.checks.filter(check => !check.ok).map(check => check.name + ': ' + check.details.join('; ')).join('\n'));
    error.validation = validation;
    throw error;
  }
  const [nodeKey, edgeKey] = collections[type];
  const labels = new Map(diagram[nodeKey].map(node => [node.id, node.label]));
  const relationships = (diagram[edgeKey] || []).map(edge => `${labels.get(edge.from) || edge.from} → ${labels.get(edge.to) || edge.to}${edge.label ? ': ' + edge.label : ''}`);
  const alt = `${diagram.meta.title}. ${[...labels.values()].join('; ')}.${relationships.length ? ' ' + relationships.join('; ') + '.' : ''}`;
  const svg = canonicalSvg(raw, diagram, alt, diagram[nodeKey].some(node => node.brand));
  if (Buffer.byteLength(svg) > 8 * 1024 * 1024) throw new Error('Rendered diagram exceeds 8 MiB');
  return { svg, spec: JSON.parse(specText), specText, specDigest: hash(specText), generatorDigest: GENERATOR_DIGEST, validation, alt, caption: diagram.meta.subtitle || diagram.meta.title };
}
