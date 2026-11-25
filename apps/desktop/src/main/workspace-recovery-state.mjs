// A file operation owns only its own protection. Preview/browser recovery keeps
// its existing independent flag, even when a tree receipt has been settled.
export const recoveryHeld = record => Boolean(record.recoveryHeld || record.treeRecoveryHolds?.size);
