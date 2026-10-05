/**
 * Taipei 101 race rules. Rendering-independent, seeded and deterministic.
 *
 * createRace(characterId, seed) -> mutable race state.
 * stepRace(state, dtSeconds, input) -> the same state. dt is capped at 1 second;
 * updates run at 60 Hz. forward/lane are continuous, action flags are commands.
 * Public lane values and x are 0..2; jump/shield/stun/fall are seconds remaining.
 * Race time excludes the three-second countdown. events retain the latest 64.
 */

export const TRACK = Object.freeze({
  floors: 101,
  lanes: 3,
  countdown: 3,
  baseSpeed: 0.46,
  checkpointEvery: 10,
  jumpDuration: 0.8,
  dashDuration: 0.75,
  shieldDuration: 0.9,
  perfectShieldWindow: 0.22,
});

export const CHARACTERS = Object.freeze([
  { id: 'Greninja', name: '甲賀忍蛙', color: '#64a8ff', description: '輕巧躍上雲端的城市跑酷高手' },
  { id: 'Lucario', name: '路卡利歐', color: '#69c4ed', description: '感受波導，抓準進攻與防禦的節奏' },
  { id: 'Mimikyu', name: '謎擬Ｑ', color: '#f1d78a', description: '小小身影，也有登上頂峰的決心' },
  { id: 'Charizard', name: '噴火龍', color: '#ff9960', description: '一路向上，用衝刺點燃賽道' },
  { id: 'Umbreon', name: '月亮伊布', color: '#f6d854', description: '冷靜觀察，抓準完美反擊的時機' },
  { id: 'Sylveon', name: '仙子伊布', color: '#ffa5d0', description: '輕盈跨越障礙，優雅向終點前進' },
  { id: 'Garchomp', name: '烈咬陸鯊', color: '#9ca5ef', description: '步步緊逼，把對手留在轉角' },
  { id: 'Rayquaza', name: '烈空坐', color: '#64d8a0', description: '穿梭高空強風，直指雲端頂峰' },
  { id: 'Gardevoir', name: '沙奈朵', color: '#9bdfc0', description: '專注掌握時機，守住每次機會' },
  { id: 'Gengar', name: '耿鬼', color: '#bf9bff', description: '穿梭霓虹夜色，出招靈巧俐落' },
]);

const HZ = 1 / 60;
const EPS = 1e-8;
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const approach = (a, b, delta) => a < b ? Math.min(b, a + delta) : Math.max(b, a - delta);

// The physical windows are deliberately narrow enough to clear with one jump.
export const HAZARDS = Object.freeze(Array.from({ length: 12 }, (_, cluster) => {
  const progress = 7 + cluster * 8;
  const type = ['barrier', 'gap', 'wind'][cluster % 3];
  const safeLane = (cluster * 2 + 1) % 3;
  const fullWidth = cluster === 3 || cluster === 7 || cluster === 11;
  return [0, 1, 2].filter(lane => fullWidth || lane !== safeLane).map(lane => Object.freeze({
    id: `hazard-${cluster}-${lane}`,
    type,
    progress,
    lane,
    start: progress - 0.075,
    end: progress + 0.075,
  }));
}).flat());

export const SUPPLIES = Object.freeze(Array.from({ length: 10 }, (_, i) => Object.freeze({
  id: `supply-${i}`, progress: 5 + i * 10, lane: 1, energy: 25,
})));
export const SHORTCUTS = Object.freeze(Array.from({ length: 5 }, (_, i) => Object.freeze({
  id: `shortcut-${i}`, progress: 12 + i * 20, start: 11.75 + i * 20,
  end: 12.35 + i * 20, lane: 0, boost: 1.4,
})));

/** Returns a hazard at this physical position, or null. */
export function hazardAt(progress, lane) {
  const nearestLane = clamp(Math.round(lane), 0, 2);
  return HAZARDS.find(h => h.lane === nearestLane && progress >= h.start && progress <= h.end) || null;
}

function seedNumber(seed) {
  if (typeof seed === 'number' && Number.isFinite(seed)) return seed >>> 0 || 1;
  let hash = 2166136261;
  for (const char of String(seed ?? 101)) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return hash >>> 0 || 1;
}

function random(state) {
  let t = state._rng += 0x6D2B79F5;
  t = Math.imul(t ^ t >>> 15, t | 1);
  t ^= t + Math.imul(t ^ t >>> 7, t | 61);
  state._rng >>>= 0;
  return ((t ^ t >>> 14) >>> 0) / 4294967296;
}

function event(state, type, racer, message, extra = {}) {
  state.events.push({ id: ++state._eventId, type, time: state.time, racerId: racer.id, message, ...extra });
  if (state.events.length > 64) state.events.splice(0, state.events.length - 64);
}

function makeRacer(id, character, lane, isPlayer, skill) {
  return {
    id, characterId: character.id, name: character.name, color: character.color,
    isPlayer, progress: 0, lane, x: lane, energy: 100,
    shield: 0, shieldAge: 10, jump: 0, jumpHeight: 0, dash: 0,
    stun: 0, fall: 0, checkpoint: 0, finished: false, finishTime: null,
    cooldowns: { attack: 0, dash: 0, shield: 0, jump: 0 },
    speed: 0, catchup: 0, poise: 100, attackFlash: 0, attackWindup: 0, hitFlash: 0,
    _laneRepeat: 0, _hazardMemory: {}, _supplies: {}, _shortcuts: {}, _attackPending: false,
    _ai: isPlayer ? null : { skill, nextDecision: 0, forward: 1, lane: 0, panic: 0 },
  };
}

export function createRace(characterId = CHARACTERS[0].id, seed = 101) {
  const normalizedSeed = seedNumber(seed);
  const state = {
    seed: normalizedSeed, playerId: 'player', time: 0, status: 'countdown',
    countdown: TRACK.countdown, racers: [], events: [], winner: null, results: [],
    _rng: normalizedSeed, _accumulator: 0, _eventId: 0,
    _pending: { jump: false, attack: false, dash: false, shield: false },
  };
  const selected = CHARACTERS.find(c => c.id === characterId) || CHARACTERS[0];
  state.racers.push(makeRacer('player', selected, 1, true, 1));
  const pool = CHARACTERS.filter(c => c.id !== selected.id);
  for (let i = 0; i < 3; i++) {
    const character = pool.splice(Math.floor(random(state) * pool.length), 1)[0];
    state.racers.push(makeRacer(`ai-${i + 1}`, character, i, false, 0.83 + random(state) * 0.12));
  }
  return state;
}

function fallToCheckpoint(state, racer, reason, attacker) {
  if (racer.fall > 0 || racer.finished) return;
  const lostFloors = Math.max(0, racer.progress - racer.checkpoint);
  racer.progress = racer.checkpoint;
  racer.fall = 1.15;
  racer.stun = 0;
  racer.jump = 0;
  racer.jumpHeight = 0;
  racer.dash = 0;
  racer.attackWindup = 0;
  racer._attackPending = false;
  racer.shield = 0;
  racer.poise = 100;
  racer.energy = Math.max(25, racer.energy - 12);
  racer.speed = 0;
  event(state, 'fall', racer, '失足！返回最近的補給站', { reason, lostFloors, attackerId: attacker?.id });
}

function knockback(state, target, attacker, reflected = false) {
  if (target.finished || target.fall > 0) return;
  target.progress = Math.max(target.checkpoint, target.progress - (reflected ? 1.3 : 0.75));
  target.poise = Math.max(0, target.poise - (reflected ? 75 : 62));
  target.stun = reflected ? 0.55 : 0.36;
  target.dash = 0;
  target.attackWindup = 0;
  target._attackPending = false;
  target.hitFlash = 0.3;
  event(state, 'hit', target, reflected ? '完美格擋，反擊成功！' : '遭到攻擊，注意腳步！', { attackerId: attacker.id, reflected });
  if (target.poise <= 0) fallToCheckpoint(state, target, 'combat', attacker);
}

function applyActions(state, racer, actions) {
  if (racer.finished || racer.fall > 0 || racer.stun > 0) return;
  if (actions.shield && racer.cooldowns.shield <= EPS && racer.energy >= 15) {
    racer.energy -= 15;
    racer.shield = TRACK.shieldDuration;
    racer.shieldAge = 0;
    racer.cooldowns.shield = 3.2;
    event(state, 'shield', racer, '護盾展開');
  }
  if (actions.jump && racer.cooldowns.jump <= EPS && racer.jump <= EPS && racer.energy >= 9) {
    racer.energy -= 9;
    racer.jump = TRACK.jumpDuration;
    racer.cooldowns.jump = 0.92;
    event(state, 'jump', racer, '躍過障礙');
  }
  if (actions.dash && racer.cooldowns.dash <= EPS && racer.energy >= 24) {
    racer.energy -= 24;
    racer.dash = TRACK.dashDuration;
    racer.cooldowns.dash = 4;
    event(state, 'dash', racer, '加速衝刺！');
  }
  if (actions.attack && racer.cooldowns.attack <= EPS && racer.energy >= 18) {
    racer.energy -= 18;
    racer.cooldowns.attack = 1.05;
    racer.attackWindup = 0.24;
    racer._attackPending = true;
    event(state, 'attack-windup', racer, '注意！對手準備攻擊');
  }
}

function resolveAttack(state, racer) {
    racer._attackPending = false;
    racer.attackFlash = 0.22;
    const targets = state.racers.filter(other => other.id !== racer.id && !other.finished && other.fall <= 0
      && Math.abs(other.progress - racer.progress) < 1.05 && Math.abs(other.x - racer.x) < 0.65);
    targets.sort((a, b) => Math.abs(a.progress - racer.progress) - Math.abs(b.progress - racer.progress));
    const target = targets[0];
    event(state, 'attack', racer, target ? '近身出擊！' : '揮拳', { targetId: target?.id });
    if (!target) return;
    if (target.jump > 0.12 && racer.jump <= 0) {
      event(state, 'evade', target, '跳躍閃避成功', { attackerId: racer.id });
    } else if (target.shield > 0) {
      if (target.shieldAge <= TRACK.perfectShieldWindow + EPS) {
        target.energy = Math.min(100, target.energy + 10);
        event(state, 'perfect', target, '完美格擋！', { targetId: racer.id });
        knockback(state, racer, target, true);
      } else {
        target.energy = Math.max(0, target.energy - 5);
        event(state, 'block', target, '成功格擋', { attackerId: racer.id });
      }
    } else knockback(state, target, racer);
}

function aiActions(state, racer, dt) {
  const ai = racer._ai;
  ai.nextDecision -= dt;
  const actions = { forward: ai.forward, lane: ai.lane };
  if (ai.nextDecision > 0 || racer.fall > 0 || racer.finished) return actions;
  ai.nextDecision = 0.085 + random(state) * 0.075;
  const leader = Math.max(...state.racers.map(r => r.progress));
  const behind = clamp((leader - racer.progress) / 12, 0, 1);
  // AI catch-up strategy uses the same abilities and costs as the player.
  ai.forward = clamp(0.86 + ai.skill * 0.11 + behind * 0.035, 0, 1);
  actions.forward = ai.forward;
  const upcoming = HAZARDS.filter(h => h.end >= racer.progress - 0.01 && h.start < racer.progress + 0.75);
  const nextHazard = upcoming.find(h => h.lane === Math.round(racer.x));
  ai.lane = 0;
  if (nextHazard) {
    const freeLanes = [0, 1, 2].filter(lane => !upcoming.some(h => h.lane === lane));
    freeLanes.sort((a, b) => Math.abs(a - racer.x) - Math.abs(b - racer.x));
    if (freeLanes.length && nextHazard.start - racer.progress > 0.1) ai.lane = Math.sign(freeLanes[0] - racer.lane);
    else {
      const speed = TRACK.baseSpeed * ai.forward * (racer.dash > 0 ? 1.95 : 1);
      if (nextHazard.start - racer.progress < speed * 0.36 && random(state) < ai.skill + 0.045) {
        if (nextHazard.type === 'wind') actions.shield = true;
        else actions.jump = true;
      }
    }
  }
  if (!nextHazard) {
    const shortcut = SHORTCUTS.find(s => !racer._shortcuts[s.id] && s.end >= racer.progress && s.start < racer.progress + 0.8);
    if (shortcut) {
      ai.lane = Math.sign(shortcut.lane - racer.lane);
      if (racer.x < 0.35 && racer.progress >= shortcut.start && random(state) < ai.skill) actions.jump = true;
    } else if (racer.energy < 70) {
      const supply = SUPPLIES.find(s => !racer._supplies[s.id] && s.progress >= racer.progress && s.progress < racer.progress + 0.65);
      if (supply) ai.lane = Math.sign(supply.lane - racer.lane);
    }
  }
  actions.lane = ai.lane;
  const rival = state.racers.find(other => other.id !== racer.id && !other.finished && other.fall <= 0
    && Math.abs(other.progress - racer.progress) < 0.85 && Math.abs(other.x - racer.x) < 0.6);
  if (rival && racer.energy > 42) {
    if (rival.attackWindup > 0 && random(state) < ai.skill * 0.75) actions.shield = true;
    if (random(state) < 0.025 + behind * 0.025) actions.attack = true;
  }
  // Avoid accelerating into a jump with no time to clear it.
  if (!nextHazard && racer.energy > 38 && random(state) < 0.065 + behind * 0.1) actions.dash = true;
  return actions;
}

function moveRacer(state, racer, dt, input) {
  if (racer.finished) return;
  for (const key of Object.keys(racer.cooldowns)) racer.cooldowns[key] = Math.max(0, racer.cooldowns[key] - dt);
  racer.attackFlash = Math.max(0, racer.attackFlash - dt);
  racer.hitFlash = Math.max(0, racer.hitFlash - dt);
  racer.shieldAge += dt;
  racer.shield = Math.max(0, racer.shield - dt);
  racer.jump = Math.max(0, racer.jump - dt);
  racer.jumpHeight = racer.jump > 0 ? Math.sin(Math.PI * (1 - racer.jump / TRACK.jumpDuration)) : 0;
  racer.dash = Math.max(0, racer.dash - dt);
  racer.stun = Math.max(0, racer.stun - dt);
  racer._laneRepeat = Math.max(0, racer._laneRepeat - dt);
  racer.poise = Math.min(100, racer.poise + dt * 18);
  racer.energy = Math.min(100, racer.energy + dt * (racer.shield > 0 ? 3 : 7.5));
  if (racer.fall > 0) {
    racer.fall = Math.max(0, racer.fall - dt);
    racer.speed = 0;
    return;
  }
  if (racer.stun > 0) {
    racer.speed = 0;
    return;
  }
  const laneCommand = Math.sign(input.lane || 0);
  if (laneCommand && racer._laneRepeat <= EPS) {
    racer.lane = clamp(racer.lane + laneCommand, 0, 2);
    racer._laneRepeat = 0.24;
  }
  if (!laneCommand) racer._laneRepeat = 0;
  racer.x = approach(racer.x, racer.lane, dt * 6);
  const forward = clamp(Number(input.forward) || 0, -1, 1);
  const leader = Math.max(...state.racers.map(r => r.progress));
  racer.catchup = clamp((leader - racer.progress - 4) / 20, 0, 0.08);
  racer.speed = TRACK.baseSpeed * forward * (1 + racer.catchup) * (racer.dash > 0 ? 1.95 : 1) * (racer.shield > 0 ? 0.78 : 1);
  racer.progress = clamp(racer.progress + racer.speed * dt, racer.checkpoint, TRACK.floors);
  for (const supply of SUPPLIES) {
    if (!racer._supplies[supply.id] && Math.abs(racer.progress - supply.progress) < 0.16 && Math.abs(racer.x - supply.lane) < 0.38) {
      racer._supplies[supply.id] = true;
      racer.energy = Math.min(100, racer.energy + supply.energy);
      event(state, 'supply', racer, '取得能量補給 +25', { supplyId: supply.id });
    }
  }
  for (const shortcut of SHORTCUTS) {
    if (!racer._shortcuts[shortcut.id] && racer.jump > 0 && racer.progress >= shortcut.start && racer.progress <= shortcut.end
      && Math.abs(racer.x - shortcut.lane) < 0.35) {
      racer._shortcuts[shortcut.id] = true;
      racer.progress = Math.min(TRACK.floors, racer.progress + shortcut.boost);
      event(state, 'shortcut', racer, '內圈跳板！搶先 1.4 層', { shortcutId: shortcut.id });
    }
  }
  const hazard = hazardAt(racer.progress, racer.x);
  if (hazard && (racer._hazardMemory[hazard.id] ?? -Infinity) < state.time - 2.2) {
    if (racer.jump <= 0 && !(hazard.type !== 'gap' && racer.shield > 0)) {
      racer._hazardMemory[hazard.id] = state.time;
      if (hazard.type === 'gap') fallToCheckpoint(state, racer, 'gap');
      else {
        racer.progress = Math.max(racer.checkpoint, racer.progress - (hazard.type === 'wind' ? 0.4 : 0.65));
        racer.stun = hazard.type === 'wind' ? 0.4 : 0.6;
        racer.dash = 0;
        racer.hitFlash = 0.3;
        racer.energy = Math.max(0, racer.energy - 8);
        event(state, 'hazard', racer, hazard.type === 'wind' ? '小心高空強風！' : '撞上障礙！試試跳躍', { hazardId: hazard.id });
      }
    }
  }
  const checkpoint = Math.min(100, Math.floor((racer.progress + EPS) / TRACK.checkpointEvery) * TRACK.checkpointEvery);
  if (checkpoint > racer.checkpoint) {
    racer.checkpoint = checkpoint;
    racer.energy = Math.min(100, racer.energy + 38);
    racer.poise = 100;
    event(state, 'checkpoint', racer, `${checkpoint}F 補給站 · 能量恢復`, { checkpoint });
  }
  if (racer.progress >= TRACK.floors - EPS) {
    racer.progress = TRACK.floors;
    racer.finished = true;
    racer.finishTime = state.time;
    racer.speed = 0;
    state.results.push({ id: racer.id, characterId: racer.characterId, name: racer.name, time: state.time });
    if (!state.winner) state.winner = racer.id;
    event(state, 'finish', racer, `${racer.name} 登頂！`, { place: state.results.length });
  }
}

function tick(state, dt, input) {
  if (state.status === 'finished') return;
  if (state.status === 'countdown') {
    state.countdown = Math.max(0, state.countdown - dt);
    if (state.countdown <= EPS) {
      state.countdown = 0;
      state.status = 'racing';
      event(state, 'start', state.racers[0], '比賽開始！向 101F 出發');
    }
    return;
  }
  state.time += dt;
  const controls = state.racers.map(racer => racer.isPlayer ? input : aiActions(state, racer, dt));
  // All shields and jumps resolve before attacks, independent of racer order.
  for (let i = 0; i < state.racers.length; i++) {
    const actions = controls[i];
    applyActions(state, state.racers[i], { ...actions, attack: false });
  }
  for (let i = 0; i < state.racers.length; i++) {
    if (controls[i].attack) applyActions(state, state.racers[i], { attack: true });
  }
  for (const racer of state.racers) {
    if (racer._attackPending) {
      racer.attackWindup = Math.max(0, racer.attackWindup - dt);
      if (racer.attackWindup <= EPS) resolveAttack(state, racer);
    }
  }
  for (let i = 0; i < state.racers.length; i++) moveRacer(state, state.racers[i], dt, controls[i]);
  // A first finisher ends the match, so an idle player cannot stall the result.
  if (state.winner) state.status = 'finished';
}

export function stepRace(state, dt, input = {}) {
  if (!state || !Array.isArray(state.racers)) throw new TypeError('stepRace requires a state from createRace');
  if (state.status === 'finished') return state;
  const elapsed = Number(dt);
  if (!Number.isFinite(elapsed) || elapsed <= 0) return state;
  const controls = {
    forward: clamp(Number(input.forward) || 0, -1, 1),
    lane: clamp(Number(input.lane) || 0, -1, 1),
  };
  for (const key of Object.keys(state._pending)) state._pending[key] ||= Boolean(input[key]);
  state._accumulator += Math.min(1, elapsed);
  while (state._accumulator + EPS >= HZ && state.status !== 'finished') {
    const actions = { ...controls, ...state._pending };
    tick(state, HZ, actions);
    for (const key of Object.keys(state._pending)) state._pending[key] = false;
    state._accumulator = Math.max(0, state._accumulator - HZ);
  }
  return state;
}
