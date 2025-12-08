// Simple scroll lock utility for overlays/modals
let overlayCount = 0;

export function lockScroll() {
  overlayCount += 1;
  if (overlayCount === 1) {
    document.body.classList.add('overlay-open');
  }
}

export function unlockScroll() {
  if (overlayCount > 0) {
    overlayCount -= 1;
    if (overlayCount === 0) {
      document.body.classList.remove('overlay-open');
    }
  }
}
