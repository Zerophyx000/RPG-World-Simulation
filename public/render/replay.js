// Step 9: map replay. STUB: the task "replay-client" implements it.
// createReplay({ fetchJson }) → controller. While active, the map view draws stateAt(liveS, realMs) instead of the live S.
export function createReplay(_opts = {}) {
  return {
    active: false, playing: false, speed: 1, from: 0, to: 0, t: 0,
    async load(_from, _to) {},
    play() {}, pause() {}, setSpeed(_x) {}, seek(_t) {},
    stop() { this.active = false; },
    stateAt(liveS, _ms) { return liveS; },
  };
}
