'use strict';
const {BaseWindow, WebContentsView} = require('electron');

// Keep chrome and document surfaces in one explicit native stacking context.
// BrowserWindow's implicit primary view is a sibling outside contentView and
// can cover returned child views on the software-composited Wayland path.
class WorkspaceWindow extends BaseWindow {
  constructor({webPreferences, ...options} = {}) {
    super(options);
    this.chromeView = new WebContentsView({webPreferences});
    this.webContents = this.chromeView.webContents;
    this.contentView.addChildView(this.chromeView);
    const root = this.contentView, addChildView = root.addChildView.bind(root);
    root.addChildView = (view, index) => {
      addChildView(view, index ?? root.children.length);
      if (view === this.chromeView) return;
      // Keep chrome below content while preserving sibling insertion order.
      // Re-adding every sibling without an explicit index can prepend guests
      // below their opaque wrapper on macOS, making loaded pages look blank.
      root.removeChildView(this.chromeView);
      addChildView(this.chromeView, 0);
    };
    let pendingResize=null;
    const resize = () => {
      if(this.isDestroyed())return;
      const [width, height] = this.getContentSize();
      this.chromeView.setBounds({x:0, y:0, width, height});
    };
    // WM state transitions can announce resize before the final client bounds.
    // Reconcile after the native event as well; never recreate document guests.
    const scheduleResize=()=>{resize();if(pendingResize===null)pendingResize=setImmediate(()=>{pendingResize=null;resize();});};
    for(const event of ['resize','resized','maximize','unmaximize','enter-full-screen','leave-full-screen','restore'])this.on(event,scheduleResize);
    this.on('closed', () => {
      clearImmediate(pendingResize);
      if (!this.webContents.isDestroyed()) this.webContents.close({waitForBeforeUnload:false});
    });
    resize();
  }
  loadURL(url) { return this.webContents.loadURL(url); }
}
module.exports = {WorkspaceWindow};
