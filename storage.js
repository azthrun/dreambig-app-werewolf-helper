/**
 * storage.js — localStorage 读写、版本化、姓名池
 * SPEC §11
 *
 * 两个彼此独立的存储域：
 *   · wolf.game  —— 单槽对局存档，随对局生命周期存亡
 *   · wolf.names —— 姓名池与上次名单，跨局留存
 *
 * 所有数据仅存于本机，永不离开设备（SPEC §11.2）。
 */

export const GAME_KEY = 'wolf.game';
export const NAMES_KEY = 'wolf.names';

/** 存档结构版本。不匹配即丢弃存档（SPEC §11.3）。 */
export const STATE_VERSION = 1;

/** 姓名池上限（SPEC §11.2） */
export const NAME_POOL_LIMIT = 50;

// ── 对局存档 ──────────────────────────────────────────────────────

/**
 * 写入完整 GameState。每次状态变更后调用，无需防抖（体积约数 KB）。
 * @param {GameState} state
 */
export function saveGame(state) {
  try {
    localStorage.setItem(GAME_KEY, JSON.stringify(state));
  } catch (err) {
    console.warn('[wolf] 存档写入失败', err);
  }
}

/**
 * 读取存档。版本不匹配时返回 null（丢弃，而非在陈旧结构上崩溃）。
 * @returns {?GameState}
 */
export function loadGame() {
  let raw;
  try {
    raw = localStorage.getItem(GAME_KEY);
  } catch (err) {
    return null;
  }
  if (!raw) return null;

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    localStorage.removeItem(GAME_KEY);
    return null;
  }

  if (!parsed || parsed.version !== STATE_VERSION) {
    console.warn('[wolf] 存档版本不匹配，已丢弃');
    localStorage.removeItem(GAME_KEY);
    return null;
  }

  return parsed;
}

/** 清空对局存档槽。 */
export function clearGame() {
  try {
    localStorage.removeItem(GAME_KEY);
  } catch (err) {
    // 忽略：无法访问 localStorage 时静默失败
  }
}

/**
 * 存档是否为「未完成对局」—— 决定 Step 1 是否显示恢复横幅。
 * 仅当存档已进入实际对局（局内 / 日志 / 战报）才视为「未完成对局」；
 * 仍处于设置向导阶段的存档直接续接编辑，不弹横幅（见 SPEC §4.1 演示场景）。
 * @returns {?{ day:number, phase:string, playerCount:number }}
 */
export function pendingGameSummary() {
  const game = loadGame();
  if (!game) return null;
  if (!['game', 'log', 'report'].includes(game.screen)) return null;
  return { day: game.day, phase: game.phase, playerCount: game.playerCount };
}

// ── 姓名池 ────────────────────────────────────────────────────────

/**
 * 读取姓名池与上次名单。
 * @returns {{ pool: string[], lastRoster: Array<{seat:number, name:string}> }}
 */
export function loadNames() {
  try {
    const raw = localStorage.getItem(NAMES_KEY);
    if (!raw) return { pool: [], lastRoster: [] };
    const parsed = JSON.parse(raw);
    return {
      pool: Array.isArray(parsed?.pool) ? parsed.pool : [],
      lastRoster: Array.isArray(parsed?.lastRoster) ? parsed.lastRoster : [],
    };
  } catch (err) {
    return { pool: [], lastRoster: [] };
  }
}

/**
 * 将本局姓名并入姓名池（去重、最近使用优先、上限 NAME_POOL_LIMIT），
 * 并记录为上次名单。开始游戏时调用。
 * @param {Array<{seat:number, name:string}>} roster
 */
export function rememberNames(roster) {
  const { pool } = loadNames();
  const usedNames = roster.map(r => r.name).filter(Boolean);
  const merged = [...usedNames, ...pool.filter(n => !usedNames.includes(n))].slice(0, NAME_POOL_LIMIT);
  try {
    localStorage.setItem(NAMES_KEY, JSON.stringify({ pool: merged, lastRoster: roster }));
  } catch (err) {
    console.warn('[wolf] 姓名池写入失败', err);
  }
}

/**
 * 清空姓名池与上次名单。不影响进行中的对局。
 * 调用方须先经长按确认（SPEC §8.2）。
 */
export function clearNames() {
  try {
    localStorage.removeItem(NAMES_KEY);
  } catch (err) {
    // 忽略
  }
}
