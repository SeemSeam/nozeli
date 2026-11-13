// Keep the original layout preview, but never maintain a second action list.
import {actionGroups,actionList} from '../../src/renderer/ui-actions.mjs';
export const iconGroups=actionGroups;
export const iconActions=Object.values(actionList);
