import test from 'node:test';
import assert from 'node:assert/strict';
import { CHARACTERS, TRACK, HAZARDS, SHORTCUTS, ITEM_PICKUPS, createRace, stepRace, hazardAt } from '../src/simulation.js';

function start(seed = 42) {
  const race = createRace(CHARACTERS[0].id, seed);
  for (let i = 0; i < 180; i++) stepRace(race, 1 / 60, {});
  assert.equal(race.status, 'racing');
  return race;
}

function isolate(race) {
  for (const racer of race.racers.slice(1)) {
    racer.progress = 0;
    racer._ai.nextDecision = 10000;
    racer._ai.forward = 0;
    racer._ai.lane = 0;
    racer.lane = 2;
    racer.x = 2;
  }
}

function advance(race, seconds, input = {}) {
  for (let i = 0; i < Math.ceil(seconds * 60); i++) stepRace(race, 1 / 60, typeof input === 'function' ? input(race) : input);
}

test('ten distinct characters and four racers with a three-second countdown', () => {
  assert.equal(CHARACTERS.length, 10);
  assert.equal(new Set(CHARACTERS.map(c => c.id)).size, 10);
  const race = createRace(CHARACTERS[4].id, 'Taipei');
  assert.equal(race.racers.length, 4);
  assert.equal(race.racers[0].characterId, CHARACTERS[4].id);
  assert.equal(new Set(race.racers.map(r => r.characterId)).size, 4);
  advance(race, 2, { forward: 1, dash: true });
  assert.equal(race.racers[0].progress, 0);
  assert.equal(race.time, 0);
  advance(race, 1);
  assert.equal(race.status, 'racing');
});

test('seeded replay is deterministic', () => {
  const a = start(1234);
  const b = start(1234);
  for (let i = 0; i < 1200; i++) {
    const input = { forward: 1, lane: Math.floor(i / 180) % 2 ? 1 : -1, jump: i % 93 === 0, dash: i % 251 === 0, attack: i % 67 === 0 };
    stepRace(a, 1 / 60, input);
    stepRace(b, 1 / 60, input);
  }
  assert.deepEqual(a, b);
});

test('lane movement is smooth and limited to three lanes', () => {
  const race = start();
  isolate(race);
  const player = race.racers[0];
  stepRace(race, 1 / 60, { lane: -1 });
  assert.equal(player.lane, 0);
  assert.ok(player.x > 0 && player.x < 1);
  advance(race, 2, { lane: -1 });
  assert.equal(player.x, 0);
  advance(race, 2, { lane: 1 });
  assert.equal(player.x, 2);
});

test('dash has a real energy cost, shared cooldown, and faster movement', () => {
  const normal = start();
  const dash = start();
  isolate(normal); isolate(dash);
  advance(normal, 0.5, { forward: 1 });
  stepRace(dash, 1 / 60, { forward: 1, dash: true });
  advance(dash, 29 / 60, { forward: 1 });
  assert.ok(dash.racers[0].progress > normal.racers[0].progress * 1.8);
  assert.ok(dash.racers[0].energy < 85);
  assert.ok(dash.racers[0].cooldowns.dash > 3);
  assert.equal(dash.events.filter(e => e.type === 'dash' && e.racerId === 'player').length, 1);
});

test('baseline movement is exactly three times the previous speed without scaling time or cooldowns', () => {
  assert.equal(TRACK.baseSpeed, 1.38);
  const race = start(); isolate(race);
  advance(race, 1, { forward: 1 });
  assert.ok(Math.abs(race.racers[0].progress - 0.46 * 3) < 1e-10);
  assert.ok(Math.abs(race.time - 1) < 1e-10);
  stepRace(race, 1 / 60, { dash: true, jump: true, shield: true });
  advance(race, 29 / 60);
  assert.ok(Math.abs(race.racers[0].cooldowns.dash - 3.5) < 1e-10);
  assert.ok(Math.abs(race.racers[0].jump - 0.3) < 1e-10);
  assert.ok(Math.abs(race.racers[0].shield - 0.4) < 1e-10);
});

test('shield in the perfect window reflects; an older shield blocks', () => {
  const race = start(); isolate(race);
  const [player, enemy] = race.racers;
  player.progress = 3; enemy.progress = 3.3;
  enemy.x = enemy.lane = 1;
  stepRace(race, 1 / 60, { attack: true });
  assert.ok(player.attackWindup > 0);
  assert.equal(player.progress, 3);
  advance(race, 0.1);
  enemy.shield = 0.9; enemy.shieldAge = 0;
  advance(race, 0.15);
  assert.ok(player.progress < 2);
  assert.ok(enemy.progress >= 3.3);
  assert.ok(race.events.some(e => e.type === 'perfect'));
  player.progress = 3; player.stun = 0; player.cooldowns.attack = 0;
  enemy.shield = 0.5; enemy.shieldAge = 0.4;
  stepRace(race, 1 / 60, { attack: true });
  advance(race, 0.25);
  assert.equal(player.progress, 3);
  assert.ok(race.events.some(e => e.type === 'block'));
});

test('repeated combat hits cause a fall to the latest checkpoint', () => {
  const race = start(); isolate(race);
  const [player, enemy] = race.racers;
  player.progress = 14; player.checkpoint = 10;
  enemy.progress = 14.4; enemy.checkpoint = 10; enemy.x = enemy.lane = 1;
  stepRace(race, 1 / 60, { attack: true });
  advance(race, 0.25);
  player.cooldowns.attack = 0;
  stepRace(race, 1 / 60, { attack: true });
  advance(race, 0.25);
  assert.equal(enemy.progress, 10);
  assert.ok(enemy.fall > 0);
});

test('jump clears a gap; an unprotected player returns to their checkpoint', () => {
  const gap = HAZARDS.find(h => h.type === 'gap');
  assert.equal(hazardAt(gap.progress, gap.lane).id, gap.id);
  assert.equal(hazardAt(1, 0), null);
  const falling = start(); isolate(falling);
  const jumping = start(); isolate(jumping);
  for (const race of [falling, jumping]) {
    Object.assign(race.racers[0], { progress: gap.start - 0.04, checkpoint: 10, lane: gap.lane, x: gap.lane });
  }
  advance(falling, 0.2, { forward: 1 });
  stepRace(jumping, 1 / 60, { forward: 1, jump: true });
  advance(jumping, 0.55, { forward: 1 });
  assert.equal(falling.racers[0].progress, 10);
  assert.ok(falling.racers[0].fall > 0);
  assert.ok(jumping.racers[0].progress > gap.end);
  assert.equal(jumping.racers[0].fall, 0);
});

test('supply checkpoints replenish energy and never move backwards', () => {
  const race = start(); isolate(race);
  const player = race.racers[0];
  player.progress = 9.999; player.energy = 20;
  stepRace(race, 1 / 60, { forward: 1 });
  assert.equal(player.checkpoint, 10);
  assert.ok(player.energy > 58);
  advance(race, 1, { forward: -1 });
  assert.equal(player.progress, 10);
});

test('idle player loses to moving AI in roughly one minute', () => {
  const race = start(2026);
  advance(race, 120);
  assert.equal(race.status, 'finished');
  assert.notEqual(race.winner, 'player');
  assert.equal(race.racers[0].progress, 0);
  assert.ok(race.time > 50 && race.time < 95, `AI finish ${race.time.toFixed(2)}s`);
  assert.equal(race.results[0].id, race.winner);
});

test('lane-one supply is collected once and inner-lane jump ramps grant a shortcut', () => {
  const race = start(); isolate(race);
  const player = race.racers[0];
  player.progress = 4.99; player.energy = 20;
  stepRace(race, 1 / 60, { forward: 1 });
  assert.ok(player.energy > 45);
  assert.equal(race.events.filter(e => e.type === 'supply').length, 1);
  advance(race, 0.1);
  assert.ok(player.energy < 47);
  player.progress = 12; player.x = player.lane = 0;
  stepRace(race, 1 / 60, { forward: 1, jump: true });
  assert.ok(player.progress >= 13.4);
  assert.equal(race.events.filter(e => e.type === 'shortcut').length, 1);
});

test('trailing racers get the same capped eight-percent catch-up benefit', () => {
  const race = start(); isolate(race);
  const player = race.racers[0];
  player.progress = 2;
  race.racers[1].progress = 20;
  stepRace(race, 1 / 60, { forward: 1 });
  assert.equal(player.catchup, 0.08);
  assert.ok(Math.abs(player.speed - TRACK.baseSpeed * 1.08) < 1e-9);
});

test('a skilled player can win a roughly one-minute full race', () => {
  const race = start(5);
  advance(race, 120, state => {
    const p = state.racers[0];
    const nearby = HAZARDS.filter(h => h.end >= p.progress && h.start < p.progress + 0.9);
    const next = nearby.find(h => h.lane === Math.round(p.x));
    const free = [0, 1, 2].find(lane => !nearby.some(h => h.lane === lane));
    const input = { forward: 1, dash: !nearby.length && p.cooldowns.dash <= 0 && p.energy >= 24 };
    if (next && free !== undefined) input.lane = Math.sign(free - p.lane);
    else if (next && next.start - p.progress < 0.11) {
      input.jump = next.type !== 'wind';
      input.shield = next.type === 'wind';
    }
    const shortcut = SHORTCUTS.find(s => !p._shortcuts[s.id] && s.end >= p.progress && s.start < p.progress + 0.8);
    if (!next && shortcut) {
      input.lane = Math.sign(shortcut.lane - p.lane);
      if (p.x < 0.35 && p.progress >= shortcut.start) input.jump = true;
    }
    const threat = state.racers.find(other => !other.isPlayer && Math.abs(other.progress - p.progress) < 1.05 && Math.abs(other.x - p.x) < 0.65);
    if (threat?.attackWindup > 0) input.shield = true;
    if (threat && !threat.shield && p.energy > 65) input.attack = true;
    return input;
  });
  assert.equal(race.winner, 'player');
  assert.ok(race.time > 50 && race.time < 95, `Player finish ${race.time.toFixed(2)}s`);
  assert.equal(race.racers[0].progress, TRACK.floors);
  const snapshot = JSON.stringify(race);
  stepRace(race, 1, { forward: 1 });
  assert.equal(JSON.stringify(race), snapshot);
});

test('invalid dt is harmless and action commands survive a sub-frame call', () => {
  const race = start(); isolate(race);
  const before = race.time;
  for (const dt of [0, -1, NaN, Infinity]) stepRace(race, dt, { forward: 1 });
  assert.equal(race.time, before);
  stepRace(race, 1 / 120, { jump: true });
  assert.equal(race.racers[0].jump, 0);
  stepRace(race, 1 / 120);
  assert.ok(race.racers[0].jump > 0);
});

test('forward item pickups are lane-one, one-use per racer, and capped at one ammo', () => {
  assert.deepEqual(ITEM_PICKUPS.map(item => item.progress), [8, 28, 48, 68, 88]);
  assert.ok(ITEM_PICKUPS.every(item => item.lane === 1));
  const race = start(); isolate(race);
  const player = race.racers[0];
  player.progress = 7.8;
  advance(race, 0.15, { forward: 1 });
  assert.equal(player.ammo, 1);
  assert.equal(player._items[ITEM_PICKUPS[0].id], true);
  player.progress = 27.8;
  advance(race, 0.15, { forward: 1 });
  assert.equal(player.ammo, 1);
  assert.equal(player._items[ITEM_PICKUPS[1].id], true);
  player.progress = 7.8; player.checkpoint = 0; player.ammo = 0;
  advance(race, 0.15, { forward: 1 });
  assert.equal(player.ammo, 0);
});

test('fire is queued across a sub-frame and consumes precisely one ammo', () => {
  const race = start(); isolate(race);
  const player = race.racers[0];
  player.ammo = 1;
  stepRace(race, 1 / 120, { fire: true });
  assert.equal(player.ammo, 1);
  assert.equal(race.projectiles.length, 0);
  stepRace(race, 1 / 120);
  assert.equal(player.ammo, 0);
  assert.equal(race.projectiles.length, 1);
  assert.equal(race.projectiles[0].ownerId, 'player');
  assert.equal(race.projectiles[0].direction, 1);
  assert.equal(race.projectiles[0].speed, 6);
  assert.ok(Math.abs(race.projectiles[0].remaining - 5.9) < 1e-10);
  advance(race, 0.2, { fire: true });
  assert.equal(race.events.filter(e => e.type === 'fire').length, 1);
});

test('fire cooldown prevents an immediate shot after picking up replacement ammo', () => {
  const race = start(); isolate(race);
  const player = race.racers[0];
  Object.assign(player, { progress: 7.81, ammo: 1 });
  stepRace(race, 1 / 60, { fire: true, forward: 1 });
  advance(race, 0.1, { forward: 1 });
  assert.equal(player.ammo, 1);
  assert.ok(player.cooldowns.fire > 0.6);
  stepRace(race, 1 / 60, { fire: true });
  assert.equal(player.ammo, 1);
  assert.equal(race.events.filter(e => e.type === 'fire').length, 1);
  advance(race, 0.8);
  stepRace(race, 1 / 60, { fire: true });
  assert.equal(player.ammo, 0);
  assert.equal(race.events.filter(e => e.type === 'fire').length, 2);
});

test('projectile hits an ahead same-lane racer and leaves a behind racer untouched', () => {
  const race = start(); isolate(race);
  const [player, target, behind] = race.racers;
  Object.assign(player, { progress: 3, ammo: 1 });
  Object.assign(target, { progress: 5, lane: 1, x: 1 });
  Object.assign(behind, { progress: 2, lane: 1, x: 1 });
  stepRace(race, 1 / 60, { fire: true });
  advance(race, 0.4);
  assert.equal(race.projectiles.length, 0);
  assert.equal(target.progress, 4.25);
  assert.equal(behind.progress, 2);
  assert.ok(race.events.some(e => e.type === 'projectile-hit' && e.racerId === target.id));
});

test('projectile misses another lane and expires after its six-floor range', () => {
  const race = start(); isolate(race);
  const [player, target, behind, distant] = race.racers;
  Object.assign(player, { progress: 3, ammo: 1 });
  Object.assign(target, { progress: 5, lane: 2, x: 2 });
  Object.assign(behind, { progress: 2, lane: 1, x: 1 });
  Object.assign(distant, { progress: 10, lane: 1, x: 1 });
  stepRace(race, 1 / 60, { fire: true });
  const first = race.projectiles[0].progress;
  advance(race, 0.4);
  assert.ok(race.projectiles[0].progress > first);
  advance(race, 0.7);
  assert.equal(race.projectiles.length, 0);
  assert.equal(target.progress, 5);
  assert.equal(behind.progress, 2);
  assert.equal(distant.progress, 10);
  assert.ok(race.events.some(e => e.type === 'projectile-expire'));
});

test('ordinary shield blocks a projectile; a perfect shield returns knockback to the shooter', () => {
  for (const perfect of [false, true]) {
    const race = start(); isolate(race);
    const [player, target] = race.racers;
    Object.assign(player, { progress: 3, ammo: 1 });
    Object.assign(target, { progress: 4, lane: 1, x: 1, shield: 0.9, shieldAge: perfect ? 0 : 0.4 });
    stepRace(race, 1 / 60, { fire: true });
    advance(race, 0.2);
    assert.equal(race.projectiles.length, 0);
    assert.equal(target.progress, 4);
    assert.equal(player.progress, perfect ? 1.7 : 3);
    assert.ok(race.events.some(e => e.type === (perfect ? 'projectile-perfect' : 'projectile-block')));
  }
});

test('large frame deltas sweep through supplies, items, shortcuts, and hazards at dash speed', () => {
  const race = start(); isolate(race);
  const player = race.racers[0];
  Object.assign(player, { progress: 4.5, energy: 50 });
  stepRace(race, 0.6, { forward: 1, dash: true });
  assert.ok(player._supplies['supply-0']);
  Object.assign(player, { progress: 7.5, dash: 0.75 });
  stepRace(race, 0.6, { forward: 1 });
  assert.equal(player.ammo, 1);
  Object.assign(player, { progress: 11.5, lane: 0, x: 0, dash: 0.75 });
  stepRace(race, 0.5, { forward: 1, jump: true });
  assert.ok(player._shortcuts['shortcut-0']);
  const gap = HAZARDS.find(h => h.type === 'gap');
  Object.assign(player, { progress: gap.start - 0.1, checkpoint: 10, lane: gap.lane, x: gap.lane, jump: 0, dash: 0.75 });
  stepRace(race, 0.5, { forward: 1 });
  assert.equal(player.progress, 10);
  assert.ok(player.fall > 0);
});

test('AI uses the same item pickup and projectile firing rules', () => {
  const race = start(2026);
  let lastEvent = 0;
  let sawAiItem = false;
  let sawAiFire = false;
  for (let i = 0; i < 120 * 60 && race.status !== 'finished'; i++) {
    stepRace(race, 1 / 60);
    for (const event of race.events.filter(e => e.id > lastEvent)) {
      if (event.racerId !== 'player' && event.type === 'item') sawAiItem = true;
      if (event.racerId !== 'player' && event.type === 'fire') sawAiFire = true;
      lastEvent = event.id;
    }
  }
  assert.equal(race.status, 'finished');
  assert.ok(sawAiItem);
  assert.ok(sawAiFire);
  assert.ok(race.racers.every(racer => racer.ammo >= 0 && racer.ammo <= 1));
});
