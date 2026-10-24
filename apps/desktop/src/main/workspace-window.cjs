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
      addChildView(view, index);
      if (view === this.chromeView) return;
      // Reinsert chrome below all content siblings. Reordering alone leaves
      // stale native compositor stacking after cross-widget reparenting.
      root.removeChildView(this.chromeView);
      addChildView(this.chromeView, 0);
      for (const child of root.children) if (child !== this.chromeView) addChildView(child);
      if(this.captureOverlay&&root.children.includes(this.captureOverlay))addChildView(this.captureOverlay);
    };
    const resize = () => {
      const [width, height] = this.getContentSize();
      this.chromeView.setBounds({x:0, y:0, width, height});
    };
    this.on('resize', resize);
    this.on('closed', () => {
      if (!this.webContents.isDestroyed()) this.webContents.close({waitForBeforeUnload:false});
    });
    resize();
  }
  loadURL(url) { return this.webContents.loadURL(url); }
}
module.exports = {WorkspaceWindow};
