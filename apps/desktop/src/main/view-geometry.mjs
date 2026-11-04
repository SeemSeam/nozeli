const axes = ['x', 'y', 'width', 'height'];

// Read the native state rather than caching a successful setter: attachment,
// project changes and recovery can change it without a renderer bounds message.
export function applyViewGeometry(view, bounds, visible) {
  if (bounds) {
    const current = view.getBounds?.();
    if (!current || axes.some(key => current[key] !== bounds[key])) view.setBounds(bounds);
  }
  if (view.getVisible?.() !== visible) view.setVisible(visible);
}
