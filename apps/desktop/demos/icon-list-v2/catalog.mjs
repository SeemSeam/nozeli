// Thin demo catalog: the production single source lives in
// ../../src/renderer/ui-actions.mjs (labels, hints, glyphs, presentation).
// This demo keeps no second action list and no private SVG assets.
import {actionGroups, actionList} from '../../src/renderer/ui-actions.mjs';
export {actionGroups as groups, actionList};
export const actions = Object.values(actionList);
