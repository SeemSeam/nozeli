/**
 * Nozeli-authored. In-memory implementation of pi-gui's
 * SessionFileCatalogStorage contract (vendor/pi-gui/packages/catalogs/src/storage.ts).
 *
 * The Nozeli host — not this worker — owns the durable session catalog. The
 * vendored SessionSupervisor requires a catalog storage to register workspaces
 * and pin session files; this implementation keeps that state process-local so
 * the worker never writes a second catalog authority. Resume flows seed it
 * explicitly from the host-pinned session file before opening a session.
 */

function refKey(sessionRef) {
  return `${sessionRef.workspaceId}::${sessionRef.sessionId}`;
}

export function createMemoryCatalogStorage() {
  const workspaces = new Map();
  const sessions = new Map();
  const sessionFiles = new Map();
  const worktrees = new Map();

  return {
    workspaces: {
      async listWorkspaces() {
        return { workspaces: [...workspaces.values()] };
      },
      async getWorkspace(workspaceId) {
        return workspaces.get(workspaceId);
      },
      async upsertWorkspace(entry) {
        workspaces.set(entry.workspaceId, { ...workspaces.get(entry.workspaceId), ...entry });
      },
      async deleteWorkspace(workspaceId) {
        workspaces.delete(workspaceId);
      },
    },
    sessions: {
      async listSessions(workspaceId) {
        return {
          sessions: [...sessions.values()].filter(
            (entry) => !workspaceId || entry.workspaceId === workspaceId,
          ),
        };
      },
      async getSession(sessionRef) {
        return sessions.get(refKey(sessionRef));
      },
      async upsertSession(entry) {
        sessions.set(refKey(entry.sessionRef), { ...sessions.get(refKey(entry.sessionRef)), ...entry });
      },
      async deleteSession(sessionRef) {
        sessions.delete(refKey(sessionRef));
      },
    },
    worktrees: {
      async listWorktrees(workspaceId) {
        return {
          worktrees: [...worktrees.values()].filter(
            (entry) => !workspaceId || entry.workspaceId === workspaceId,
          ),
        };
      },
      async getWorktree(worktreeId) {
        return worktrees.get(worktreeId);
      },
      async upsertWorktree(entry) {
        worktrees.set(entry.worktreeId, entry);
      },
      async deleteWorktree(worktreeId) {
        worktrees.delete(worktreeId);
      },
      async replaceWorkspaceWorktrees(workspaceId, entries) {
        for (const [worktreeId, entry] of [...worktrees]) {
          if (entry.workspaceId === workspaceId && !entries.some((next) => next.worktreeId === worktreeId)) {
            worktrees.delete(worktreeId);
          }
        }
        for (const entry of entries) {
          worktrees.set(entry.worktreeId, entry);
        }
      },
    },
    async getSessionFile(sessionRef) {
      return sessionFiles.get(refKey(sessionRef));
    },
    async setSessionFile(sessionRef, sessionFile) {
      sessionFiles.set(refKey(sessionRef), sessionFile);
    },
    async deleteSessionFile(sessionRef) {
      sessionFiles.delete(refKey(sessionRef));
    },
    async replaceWorkspaceSessions(workspaceId, entries, files) {
      const keep = new Set(entries.map((entry) => refKey(entry.sessionRef)));
      for (const key of [...sessions.keys()]) {
        if (key.startsWith(`${workspaceId}::`) && !keep.has(key)) {
          sessions.delete(key);
        }
      }
      for (const entry of entries) {
        sessions.set(refKey(entry.sessionRef), entry);
      }
      for (const [sessionId, file] of Object.entries(files ?? {})) {
        sessionFiles.set(refKey({ workspaceId, sessionId }), file);
      }
    },
  };
}

/** Seed the in-memory catalog so `openSession` can resolve a host-pinned resume. */
export function seedResumeSession(storage, { workspaceId, cwd, sessionId, sessionFile }) {
  const now = new Date().toISOString();
  return Promise.all([
    storage.workspaces.upsertWorkspace({
      workspaceId,
      path: cwd,
      displayName: workspaceId,
      lastOpenedAt: now,
      sortOrder: 0,
      pinned: false,
    }),
    storage.sessions.upsertSession({
      sessionRef: { workspaceId, sessionId },
      workspaceId,
      title: sessionId,
      updatedAt: now,
      status: "idle",
      sessionFilePath: sessionFile,
    }),
    storage.setSessionFile({ workspaceId, sessionId }, sessionFile),
  ]);
}
