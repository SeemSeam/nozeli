// Shared by the pinned PPTist editor components and the Nozeli host bridge.
// Commits are synchronous so a snapshot/export cannot race the editor debounce.
const commits=new Set();
export function registerPptTextCommit(commit){commits.add(commit);return()=>commits.delete(commit);}
export function flushPptTextCommits(){let changed=false;for(const commit of commits)if(commit())changed=true;return changed;}
