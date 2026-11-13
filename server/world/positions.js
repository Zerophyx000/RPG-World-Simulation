// Step 9: every position change as an event, for map replay. STUB: the task "server-replay" implements it.
export class Positions {
  constructor(world) {
    this.world = world;
  }

  /** A trip begins (room move or spot walk): trip = { kind, fromRoom, fromSpot, toRoom, toSpot, minutes, path } */
  onTripStart(_citizen, _trip) {}

  /** A trip ends (arrival, walk done, director teleport). */
  onTrip(_citizen, _trip) {}
}
