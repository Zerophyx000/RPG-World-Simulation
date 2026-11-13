// Step 9: the director camera. STUB: the task "director-cam" implements it.
// createDirectorCam({ fetchJson }) → controller; the map view calls update(dt, S, cam) every frame while active and moves
// the camera to the returned goal { x, y, zoom } (world px), showing `caption`.
export function createDirectorCam(_opts = {}) {
  return {
    active: false,
    caption: '',
    start() { this.active = true; },
    stop() { this.active = false; },
    /** A manual pan/zoom pauses it (until resumed). */
    pause() { this.active = false; },
    update(_dt, _S, _cam, _people) { return null; },
  };
}
