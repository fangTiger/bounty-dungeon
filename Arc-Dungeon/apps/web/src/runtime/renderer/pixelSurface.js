export const INTERNAL_WIDTH = 320;
export const INTERNAL_HEIGHT = 180;
export const TILE_SIZE = 16;

// Must be module-level: createPixelSurface calls resize() immediately in its
// body (before any const declarations inside the function), so declaring this
// inside the function causes a TDZ ReferenceError on the first resize() call.
export const MIN_FRACTIONAL_SCALE = 1.25;

/**
 * createPixelSurface — crisp pixel rendering via direct-canvas path.
 *
 * Instead of drawing into a 320×180 offscreen canvas and then blitting
 * it scaled, we draw directly into the display canvas with a CSS-integer
 * pixel scale applied via setTransform.  This avoids one upscale step
 * which used to blur the pixel-art font through bilinear interpolation.
 *
 * Backing size  = 320*k × 180*k  where  k = scale × round(devicePixelRatio)
 * CSS size      = 320*scale × 180*scale  (unchanged from before)
 * Transform     = scale(k, k)  so game code keeps working in 320×180 coords
 * present()     just re-applies the transform (no blit needed)
 *
 * canvas.width / canvas.height now equal 320*k / 180*k — do not assume 320.
 * All game code that reads surface.width / surface.height still gets 320 / 180.
 */
export function createPixelSurface(displayCanvas) {
  const context = displayCanvas.getContext("2d");

  if (!context) {
    throw new Error("无法创建像素渲染画布上下文");
  }

  let scale = 1;
  let dprScale = 1;

  setImageSmoothing(context, false);
  resize();

  function resize() {
    const { cssWidth, cssHeight } = getAvailableSize(displayCanvas);
    // Single source of truth — delegates to the exported computeScale().
    scale = computeScale(cssWidth, cssHeight);

    // Integer device-pixel multiplier keeps pixels crisp on HiDPI displays.
    dprScale = Math.max(1, Math.round(
      (typeof window !== "undefined" ? window.devicePixelRatio : 1) || 1,
    ));
    const k = scale * dprScale;

    // Backing size uses rounded pixel counts to avoid fractional canvas sizes.
    const backingWidth  = Math.round(INTERNAL_WIDTH  * k);
    const backingHeight = Math.round(INTERNAL_HEIGHT * k);
    const cssW = INTERNAL_WIDTH  * scale;
    const cssH = INTERNAL_HEIGHT * scale;

    displayCanvas.width  = backingWidth;
    displayCanvas.height = backingHeight;
    displayCanvas.style.width  = `${cssW}px`;
    displayCanvas.style.height = `${cssH}px`;

    setImageSmoothing(context, false);
    context.setTransform(k, 0, 0, k, 0, 0);
  }

  function present() {
    // Nothing to blit — game code already drew into the display canvas.
    // Re-apply transform in case the context state was popped.
    const k = scale * dprScale;
    setImageSmoothing(context, false);
    context.setTransform(k, 0, 0, k, 0, 0);
  }

  return {
    context,
    width:  INTERNAL_WIDTH,
    height: INTERNAL_HEIGHT,
    resize,
    present,
    get scale() { return scale; },
  };
}

/**
 * computeScale(cssWidth, cssHeight) — exported for unit tests.
 * Returns the CSS scale multiplier (may be fractional when ≥ MIN_FRACTIONAL_SCALE).
 */
export function computeScale(cssWidth, cssHeight) {
  const fitScale = Math.min(cssWidth / INTERNAL_WIDTH, cssHeight / INTERNAL_HEIGHT);
  const intScale = Math.floor(fitScale);
  if (intScale < 2 && fitScale >= MIN_FRACTIONAL_SCALE) {
    return Math.floor(fitScale * 100) / 100;
  }
  return Math.max(1, intScale);
}

export function setImageSmoothing(context, enabled) {
  context.imageSmoothingEnabled = enabled;
  context.mozImageSmoothingEnabled = enabled;
  context.webkitImageSmoothingEnabled = enabled;
  context.msImageSmoothingEnabled = enabled;
}

function getAvailableSize(displayCanvas) {
  const container = displayCanvas.parentElement ?? displayCanvas;
  const bounds = container.getBoundingClientRect();
  const cssWidth  = bounds.width  || INTERNAL_WIDTH;
  const cssHeight = bounds.height || INTERNAL_HEIGHT;
  return { cssWidth, cssHeight };
}
