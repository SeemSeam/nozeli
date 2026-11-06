// Pure geometry for the online web guest clip. The guest keeps ONE full
// viewport rect; floating local windows publish occlusion rows ({rect}) and
// the host paints/hit-tests only the largest unobstructed portion of that
// unchanged rect. Never shrink the viewport itself — that would reflow the
// page.

// Largest unobstructed sub-rectangle of `rect` after removing every occlusion
// row. Mirrors the isolated-preview strategy: four candidate strips per
// occluder, largest area wins; malformed rows are ignored, not fatal.
export function largestUnobstructedRect(rect, occlusions) {
  let x = rect.x, y = rect.y, right = rect.x + rect.width, bottom = rect.y + rect.height;
  for (const row of occlusions) {
    const other = row?.rect ?? row;
    if (!other || !['x', 'y', 'width', 'height'].every(key => Number.isFinite(other[key]))) continue;
    const oLeft = other.x, oTop = other.y, oRight = other.x + other.width, oBottom = other.y + other.height;
    if (oRight <= x || oLeft >= right || oBottom <= y || oTop >= bottom) continue;
    const areas = [
      [x, y, Math.max(x, oLeft), bottom],
      [Math.min(right, oRight), y, right, bottom],
      [x, y, right, Math.max(y, oTop)],
      [x, Math.min(bottom, oBottom), right, bottom],
    ];
    areas.sort((a, b) => (b[2] - b[0]) * (b[3] - b[1]) - (a[2] - a[0]) * (a[3] - a[1]));
    [x, y, right, bottom] = areas[0];
  }
  return {x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y)};
}

// Intersection of two rects ({x,y,width,height}); empty when disjoint.
export function intersectRect(a, b) {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  const width = Math.min(a.x + a.width, b.x + b.width) - x, height = Math.min(a.y + a.height, b.y + b.height) - y;
  return {x, y, width: Math.max(0, width), height: Math.max(0, height)};
}
