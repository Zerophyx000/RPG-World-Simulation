// Step 10: items in motion, visual only. Each kind of item moves its own way (content/art/item-motions.json):
//   thrown      a thrown thing flies from the thrower to where it lands in an arc, spinning, then lands by material:
//               glass shatters, clay cracks, iron sparks, wood and stone raise dust, flour puffs, straw scatters
//   struck/broken  a blow or a break shakes the thing; breaking throws its material's debris (splinters, shards, sparks)
//   slammed     a door, shutters or a chest that opens, closes, locks or is barred jolts (and a barred door thumps dust)
//   pushed      furniture pushed against a door slides there and stays against it (a barricade you can see); pushed
//               aside, it slides back
//   fire        catching fire by material (flour flashes in a puff, cloth and paper flare, wood takes slowly);
//               water on a fire hisses up in steam
// The layer only reads S.objects / F.objectPos / F.people and moves, hides or adds drawings; nothing goes back.
import { motionOf } from '../art/itemmotion.js';
import { TILE } from '../art/mapdata.js';

const FLIGHT_MS = 480;
const SHAKE_MS = 320;
const SLIDE_MS = 1100;
const BURST = { splinter: 3, shards: 3, spark: 2, dust: 2, clay: 2, puff: 3, scrap: 2, straw: 2, steam: 3, flame: 2 };

export function createItems(ctx) {
  const prev = new Map();    // object id -> { holderId, roomId, state, durability, barricade, burning, x, y }
  const flights = new Map(); // object id -> { from, to, born, sprite, mat }
  const shakes = new Map();  // object id -> { born, amp }
  const slides = new Map();  // object id -> { from: {x,y}, born }
  const lastPeople = new Map(); // id -> { x, y } from the last frame (people are placed after the ground phase)
  const table = () => ctx.art?.itemMotions;
  const on = () => ctx.quality?.get?.('particles') !== false;
  const burst = (F, kind, x, y) => { if (!kind || kind === 'none' || !on()) return; for (let i = 0; i < (BURST[kind] ?? 1); i++) F.emit(kind, x + (i - 1) * 3, y); };

  return {
    id: 'items',
    // where everyone stood this frame, for the next frame's flights
    entities(F) { for (const [id, p] of F.people) lastPeople.set(id, { x: p.x, y: p.y }); },
    // after the objects are placed (F.objectPos) and before they are queued for drawing (that is when F.hide counts)
    ground(F) {
      const S = F.S; const ms = F.ms;
      const objects = S.objects ?? new Map();
      for (const o of objects.values()) {
        const p = F.objectPos.get(o.id);
        const was = prev.get(o.id);
        const now = { holderId: o.holderId ?? null, roomId: o.roomId ?? null, state: o.state, durability: o.data?.durability ?? null, barricade: o.data?.barricade ?? null, burning: Boolean(o.data?.burning), x: p?.x ?? was?.x ?? null, y: p?.y ?? was?.y ?? null };
        prev.set(o.id, now);
        if (!was) continue;
        const m = motionOf(table(), o);
        // thrown (or dropped hard): from a holder's hands to the floor somewhere
        if (was.holderId && !now.holderId && now.roomId && p) {
          const thrower = F.people.get(was.holderId) ?? lastPeople.get(was.holderId);
          // thrown at someone: it flies at them (even close up), then lies where it fell
          const ex = (S.altercations ?? []).flatMap((al) => al.exchanges ?? []).filter((e) => e.action === 'throw_at' && e.actor === was.holderId).at(-1);
          const victim = ex && (S.now ?? 0) - ex.at < 1 ? F.people.get(ex.target) ?? lastPeople.get(ex.target) : null;
          const to = victim ? { x: victim.x, y: victim.y - (ex.hit ? 14 : 0) } : { x: p.x, y: p.y };
          const dist = thrower ? Math.hypot(thrower.x - to.x, thrower.y - to.y) : 0;
          if (thrower && (victim || dist > TILE * 0.4)) flights.set(o.id, { from: { x: thrower.x, y: thrower.y - 14 }, to, born: ms, sprite: p.sprite, m, hit: Boolean(ex?.hit) });
        }
        // a break, a blow (durability drops), a slam
        if (p && (now.state !== was.state || (now.durability != null && was.durability != null && now.durability < was.durability - 0.5))) {
          const broke = now.state === 'broken' || (o.data?.broken && was.state === now.state && now.durability === 0);
          const slam = ['open', 'closed', 'locked', 'barred'].includes(now.state) && now.state !== was.state;
          if (broke || now.durability < (was.durability ?? Infinity) || slam) shakes.set(o.id, { born: ms, amp: broke ? 3 : slam ? 1 : (m.cls.shake ?? 2) });
          if (broke) { burst(F, m.mat.break, p.x, p.y - (p.sprite?.h ?? 12) / 2); burst(F, m.mat.break, p.x + 4, p.y - 4); }
          else if (now.durability < (was.durability ?? Infinity)) burst(F, m.mat.hit, p.x, p.y - (p.sprite?.h ?? 12) / 2);
          if (slam && now.state === 'barred') burst(F, 'dust', p.x, p.y - 4);
        }
        // pushed against a door, or away from it: it slides
        if (now.barricade !== was.barricade && was.x != null) slides.set(o.id, { from: { x: was.x, y: was.y }, born: ms });
        // catching fire by material; water on a fire: steam
        if (p && now.burning && !was.burning) {
          const h = p.sprite?.h ?? 12;
          if (m.mat.burn === 'flash') { burst(F, 'puff', p.x, p.y - h / 2); burst(F, 'flame', p.x, p.y - h / 2); }
          else if (m.mat.burn === 'fast') burst(F, 'flame', p.x, p.y - h / 2);
        }
        if (p && was.burning && !now.burning && o.data?.scorched) burst(F, 'steam', p.x, p.y - (p.sprite?.h ?? 12) / 2);
      }
      // positions this frame: barricades stand against their door; slides, shakes, flights move the drawing
      for (const o of objects.values()) {
        const p = F.objectPos.get(o.id);
        if (!p) continue;
        if (o.data?.barricade) {
          const door = F.objectPos.get(o.data.barricade);
          if (door && door.roomId === p.roomId) { p.x = door.x; p.y = door.y + (door.wall === 'side' ? 0 : TILE * 0.9); }
        }
        const sl = slides.get(o.id);
        if (sl) {
          const t = Math.min(1, (ms - sl.born) / SLIDE_MS);
          const e = t * t * (3 - 2 * t);
          p.x = sl.from.x + (p.x - sl.from.x) * e; p.y = sl.from.y + (p.y - sl.from.y) * e;
          if (t >= 1) slides.delete(o.id);
          else if (Math.floor(ms / 140) !== Math.floor((ms - 16) / 140)) burst(F, 'dust', p.x, p.y);
        }
        const sh = shakes.get(o.id);
        if (sh) {
          const t = (ms - sh.born) / SHAKE_MS;
          if (t >= 1) shakes.delete(o.id);
          else p.x += Math.round(Math.sin(ms / 28) * sh.amp * (1 - t));
        }
        if (flights.has(o.id)) F.hide.add(o.id);
      }
      // the flights themselves, drawn as y-sorted entities above the floor
      for (const [id, f] of flights) {
        const t = (ms - f.born) / FLIGHT_MS;
        if (t >= 1) {
          flights.delete(id);
          F.hide.delete(id);
          burst(F, f.m.mat.land, f.to.x, f.to.y - 2);
          continue;
        }
        const x = f.from.x + (f.to.x - f.from.x) * t;
        const yLine = f.from.y + (f.to.y - f.from.y) * t;
        const y = yLine - Math.sin(Math.PI * t) * 22; // the arc
        const sp = f.sprite;
        if (!sp || !F.inView(x, y)) continue;
        F.ents.push({
          y: yLine + 30, id: `flight-${id}`, draw: () => {
            F.dropShadow(x, yLine + 14, 3, 1, 0.25);
            F.target.blit(sp.img, F.X(x - sp.ax), F.Y(y - sp.ay), { scale: F.z, flipX: Math.floor(ms / 90) % 2 === 1 }); // a spin
          },
        });
      }
    },
  };
}
