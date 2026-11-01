/**
 * Nozeli-authored. Pure context-delivery normalizers for the owner runtime
 * bridge: byte-exact budget parsing, the explicit-materials envelope and the
 * ephemeral per-request projection envelope. Deliberately dependency-free
 * (Node builtins only) so ordinary unit suites can exercise the delivery
 * contracts without the private Pi runtime; the bridge wires these into the
 * native before_agent_start/context hooks (see bridge.mjs, design
 * docs/context-delivery-design.md §5/§9).
 */
import { createHash } from "node:crypto";

// Context-cutover budget defaults (docs/context-delivery-design.md §9).
// Calibratable per start() via params.budget; these are byte ceilings, not
// token estimates, and never resize a real model window.
export const CONTEXT_BUDGET_DEFAULTS = Object.freeze({
  projectionMaxBytes: 4096,
  runHostTextMaxBytes: 64 * 1024,
  generationHostTextMaxBytes: 256 * 1024,
});
export const utf8Bytes = (value) => Buffer.byteLength(value, "utf8");
export const sha256Hex = (value) => createHash("sha256").update(value, "utf8").digest("hex");

function escapeAttribute(value) {
  return String(value).replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

export function parseContextBudget(budget) {
  if (budget === undefined || budget === null) {
    return { ...CONTEXT_BUDGET_DEFAULTS };
  }
  if (typeof budget !== "object") {
    throw Object.assign(new Error("budget must be an object"), { code: "PI_INVALID_PARAMS" });
  }
  const parsed = { ...CONTEXT_BUDGET_DEFAULTS };
  for (const key of Object.keys(CONTEXT_BUDGET_DEFAULTS)) {
    const value = budget[key];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
      throw Object.assign(
        new Error(`budget.${key} must be a positive integer byte ceiling`),
        { code: "PI_INVALID_PARAMS" },
      );
    }
    parsed[key] = value;
  }
  return parsed;
}

/**
 * Explicit user materials for one send transaction. Exact body text is kept
 * verbatim inside per-material delimiters; identity/version/provenance ride
 * both the readable envelope and the persisted entry details. Instructions
 * found inside material text are data, never system authority.
 */
export function normalizeMaterials(materials, { requestId, jobId }) {
  if (materials === undefined || materials === null) {
    return null;
  }
  if (!Array.isArray(materials) || materials.length === 0) {
    throw Object.assign(new Error("materials must be a non-empty array when provided"), {
      code: "PI_INVALID_PARAMS",
    });
  }
  const items = materials.map((material) => {
    if (!material || typeof material !== "object") {
      throw Object.assign(new Error("each material must be an object"), {
        code: "PI_INVALID_PARAMS",
      });
    }
    if (typeof material.id !== "string" || !material.id) {
      throw Object.assign(new Error("material.id is required"), { code: "PI_INVALID_PARAMS" });
    }
    if (material.version === undefined || material.version === null) {
      throw Object.assign(new Error(`material ${material.id} requires a version`), {
        code: "PI_INVALID_PARAMS",
      });
    }
    if (typeof material.text !== "string" || !material.text) {
      throw Object.assign(new Error(`material ${material.id} requires readable text`), {
        code: "PI_INVALID_PARAMS",
      });
    }
    return {
      id: material.id,
      version: String(material.version),
      ...(typeof material.title === "string" && material.title ? { title: material.title } : {}),
      ...(typeof material.mediaType === "string" && material.mediaType
        ? { mediaType: material.mediaType }
        : {}),
      ...(material.provenance && typeof material.provenance === "object"
        ? { provenance: material.provenance }
        : {}),
      text: material.text,
      bytes: utf8Bytes(material.text),
      sha256: sha256Hex(material.text),
    };
  });
  const totalBytes = items.reduce((sum, item) => sum + item.bytes, 0);
  const sections = items.map((item) => {
    const attributes = [
      `id="${escapeAttribute(item.id)}"`,
      `version="${escapeAttribute(item.version)}"`,
      `bytes="${item.bytes}"`,
      `sha256="${item.sha256}"`,
      ...(item.mediaType ? [`mediaType="${escapeAttribute(item.mediaType)}"`] : []),
      ...(item.title ? [`title="${escapeAttribute(item.title)}"`] : []),
      ...(item.provenance?.source
        ? [`source="${escapeAttribute(item.provenance.source)}"`]
        : []),
      ...(item.provenance?.versionLabel
        ? [`sourceVersion="${escapeAttribute(item.provenance.versionLabel)}"`]
        : []),
    ];
    return `<nozeli-material ${attributes.join(" ")}>\n${item.text}\n</nozeli-material>`;
  });
  const envelopeText =
    `<nozeli-materials${requestId ? ` request="${escapeAttribute(requestId)}"` : ""} count="${items.length}">\n` +
    `${sections.join("\n")}\n</nozeli-materials>`;
  return {
    items,
    totalBytes,
    envelopeBytes: utf8Bytes(envelopeText),
    // One persisted native custom message bound to the same run/job as the
    // raw user entry; provenance identity is journaled with the entry.
    message: {
      customType: "nozeli-materials",
      content: [{ type: "text", text: envelopeText }],
      display: false,
      details: {
        ...(requestId ? { requestId } : {}),
        ...(jobId !== undefined ? { jobId } : {}),
        materials: items.map(({ id, version, sha256, bytes }) => ({ id, version, sha256, bytes })),
      },
    },
  };
}

/**
 * The single ephemeral per-request projection. Delivered through the native
 * `context` hook on every LLM call of the admitted run only: it is appended to
 * the per-request message list after Pi's own clone, so it never enters the
 * session journal and never accumulates. Compaction-phase model calls (before
 * agent_start) are excluded via the bridge's run-active gate.
 */
export function normalizeProjection(projection, projectionMaxBytes) {
  if (projection === undefined || projection === null) {
    return null;
  }
  if (typeof projection !== "object" || typeof projection.text !== "string" || !projection.text) {
    throw Object.assign(new Error("projection requires non-empty text"), {
      code: "PI_INVALID_PARAMS",
    });
  }
  const bytes = utf8Bytes(projection.text);
  if (bytes > projectionMaxBytes) {
    // A truncated control projection is worse than a blocked request: the
    // host must shrink/repage it, never silently lose safety facts.
    throw Object.assign(
      new Error(
        `projection is ${bytes} UTF-8 bytes, over the ${projectionMaxBytes} byte ceiling; refusing to send a truncated control projection`,
      ),
      { code: "PI_PROJECTION_OVER_BUDGET", bytes, projectionMaxBytes },
    );
  }
  const sources = Array.isArray(projection.sources)
    ? projection.sources
        .filter((source) => source && typeof source.id === "string")
        .map((source) => `${source.id}@${source.version ?? "?"}`)
    : [];
  const generation =
    projection.generation === undefined || projection.generation === null
      ? undefined
      : String(projection.generation);
  const envelopeText =
    `<nozeli-context-projection${sources.length ? ` sources="${escapeAttribute(sources.join(" "))}"` : ""}${generation ? ` generation="${escapeAttribute(generation)}"` : ""}>\n` +
    `${projection.text}\n</nozeli-context-projection>`;
  return {
    bytes,
    sha256: sha256Hex(envelopeText),
    envelopeText,
    sources,
    ...(generation ? { generation } : {}),
    llmCalls: 0,
  };
}
