// Step 8: map preview (/map-preview.html): the map files drawn with the real tiles, plus spots, doors and adjacency,
// plus the boot consistency check run live. For authors of maps; read-only.
import { makePalette } from './art/palette.js';
import { makeTiles } from './art/tiles.js';
import { buildGrid, mapRooms, validateMaps, TILE, spotCenter } from './art/mapdata.js';
import { CanvasTarget } from './art/target.js';

const [art, mapsRes, world] = await Promise.all([fetch('/api/art').then((r) => r.json()), fetch('/api/maps').then((r) => r.json()), fetch('/api/world').then((r) => r.json())]);
const pal = makePalette(art.palette);
const tiles = makeTiles(pal);
const roomsMap = new Map(world.rooms.map((r) => [r.id, r]));
const problems = validateMaps(mapsRes.maps, roomsMap);
document.getElementById('problems').innerHTML = problems.length
  ? `<div class="bad"><b>${problems.length} problem(s):</b><ul>${problems.map((p) => `<li>${p}</li>`).join('')}</ul></div>`
  : '<div class="ok">OK: the maps match the room graph (every room has a footprint, every exit a door or path, every spot is reachable)</div>';
const $ = (id) => document.getElementById(id);
const hue = (s) => { let h = 0; for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) % 360; return h; };

function draw() {
  const host = $('maps'); host.innerHTML = '';
  const scale = Number($('o-scale').value);
  for (const map of mapsRes.maps) {
    const grid = buildGrid(map);
    const cv = document.createElement('canvas'); cv.width = grid.W * TILE * scale; cv.height = grid.H * TILE * scale;
    const g = cv.getContext('2d'); g.imageSmoothingEnabled = false; g.scale(scale, scale);
    for (let cy = 0; cy * 16 < grid.H; cy++) for (let cx = 0; cx * 16 < grid.W; cx++) g.drawImage(CanvasTarget.canvasOf(tiles.chunkWithWalls(grid, cx, cy, 16, 0)), cx * 512, cy * 512); // every wall painted in
    g.font = '10px monospace'; g.lineWidth = 1.5;
    for (const room of mapRooms(map)) {
      const r = room.rect; const h = hue(room.roomId); const col = `hsl(${h} 85% 62%)`; const fill = `hsla(${h} 85% 62% / 0.3)`;
      g.strokeStyle = col; g.strokeRect(r.x * TILE + 0.5, r.y * TILE + 0.5, r.w * TILE, r.h * TILE);
      g.fillStyle = col; g.fillText(room.roomId, r.x * TILE + 4, r.y * TILE + 11);
      if ($('o-spots').checked) {
        for (const s of room.spots ?? []) {
          g.fillStyle = fill;
          for (const [x, y] of s.tiles) g.fillRect(x * TILE, y * TILE, TILE, TILE);
          const [cx, cy] = spotCenter(s);
          g.fillStyle = '#fff'; g.fillText(s.id + (s.default ? '*' : ''), cx * TILE + 2, cy * TILE + TILE / 2);
        }
      }
      if ($('o-adj').checked) {
        g.strokeStyle = 'rgba(255,255,255,0.55)'; g.lineWidth = 1;
        const byId = new Map((room.spots ?? []).map((s) => [s.id, s]));
        for (const [a, b] of room.adjacency ?? []) {
          const A = byId.get(a); const B = byId.get(b); if (!A || !B) continue;
          const [ax, ay] = spotCenter(A); const [bx, by] = spotCenter(B);
          g.beginPath(); g.moveTo((ax + 0.5) * TILE, (ay + 0.5) * TILE); g.lineTo((bx + 0.5) * TILE, (by + 0.5) * TILE); g.stroke();
        }
        g.lineWidth = 1.5;
      }
      if ($('o-doors').checked) {
        for (const d of room.doors ?? []) {
          g.strokeStyle = '#ff4'; g.strokeRect(d.tile[0] * TILE + 2, d.tile[1] * TILE + 2, TILE - 4, TILE - 4);
          g.fillStyle = '#ff4'; g.fillText(`-> ${[].concat(d.to).join(', ')}`, d.tile[0] * TILE - 10, d.tile[1] * TILE + TILE + 11);
        }
      }
    }
    if ($('o-grid').checked) {
      g.strokeStyle = 'rgba(0,0,0,0.3)'; g.lineWidth = 0.5;
      for (let x = 0; x <= grid.W; x++) { g.beginPath(); g.moveTo(x * TILE, 0); g.lineTo(x * TILE, grid.H * TILE); g.stroke(); }
      for (let y = 0; y <= grid.H; y++) { g.beginPath(); g.moveTo(0, y * TILE); g.lineTo(grid.W * TILE, y * TILE); g.stroke(); }
    }
    const h2 = document.createElement('h2'); h2.textContent = `${map.name ?? map.id} (${grid.W}x${grid.H} tiles)`; h2.style.fontSize = '15px';
    host.append(h2, cv);
  }
}
for (const id of ['o-spots', 'o-adj', 'o-doors', 'o-grid', 'o-scale']) $(id).addEventListener('change', draw);
draw();
