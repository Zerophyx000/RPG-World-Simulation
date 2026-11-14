// Step 9: every position change as an event (type 'position'), so the map can replay what happened: trips between
// rooms and walks between spots (start and end, with the tile path the server computed) and director teleports.
// A visual record only: citizens never see these events.
const KIND = { room: ['trip-start', 'trip-end'], spot: ['walk-start', 'walk-end'] };
const MAX_PATH = 200;

export class Positions {
  constructor(world) {
    this.world = world;
  }

  #log(c, trip, kind) {
    if (c.kind && c.kind !== 'citizen') return;
    const ends = kind !== 'trip-start' && kind !== 'walk-start';
    this.world.logEvent('position', {
      actorId: c.id, location: ends ? trip.toRoom : (trip.fromRoom ?? trip.toRoom),
      kind, fromRoom: trip.fromRoom ?? null, toRoom: trip.toRoom ?? null, fromSpot: trip.fromSpot ?? null, toSpot: trip.toSpot ?? null,
      minutes: trip.minutes != null ? Math.round(trip.minutes * 100) / 100 : null,
      path: Array.isArray(trip.path) ? trip.path.slice(0, MAX_PATH) : null,
    });
  }

  /** A trip begins (room move or spot walk). */
  onTripStart(c, trip) {
    const k = KIND[trip?.kind];
    if (k) this.#log(c, trip, k[0]);
  }

  /** A trip ends (arrival, walk done) or a director teleport. */
  onTrip(c, trip) {
    if (trip?.kind === 'teleport') { this.#log(c, trip, 'teleport'); return; }
    const k = KIND[trip?.kind];
    if (k) this.#log(c, trip, k[1]);
  }
}
