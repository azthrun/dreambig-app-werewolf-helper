/**
 * storage.js — localStorage 读写、版本化、姓名池
 * SPEC §11
 *
 * 两个彼此独立的存储域：
 *   · wolf.game  —— 单槽对局存档，随对局生命周期存亡
 *   · wolf.names —— 姓名池与上次名单，跨局留存
 *
 * 所有数据仅存于本机，永不离开设备（SPEC §11.2）。
 *
 * ⚠️ 尚未实现 —— 仅为签名骨架。
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
  throw new Error('未实现');
}

/**
 * 读取存档。版本不匹配时返回 null（丢弃，而非在陈旧结构上崩溃）。
 * @returns {?GameState}
 */
export function loadGame() {
  throw new Error('未实现');
}

/** 清空对局存档槽。 */
export function clearGame() {
  throw new Error('未实现');
}

/**
 * 存档是否为「未完成对局」—— 决定 Step 1 是否显示恢复横幅。
 * @returns {?{ day:number, phase:string, playerCount:number }}
 */
export function pendingGameSummary() {
  throw new Error('未实现');
}

// ── 姓名池 ────────────────────────────────────────────────────────

/**
 * 读取姓名池与上次名单。
 * @returns {{ pool: string[], lastRoster: Array<{seat:number, name:string}> }}
 */
export function loadNames() {
  throw new Error('未实现');
}

/**
 * 将本局姓名并入姓名池（去重、最近使用优先、上限 NAME_POOL_LIMIT），
 * 并记录为上次名单。开始游戏时调用。
 * @param {Array<{seat:number, name:string}>} roster
 */
export function rememberNames(roster) {
  throw new Error('未实现');
}

/**
 * 清空姓名池与上次名单。不影响进行中的对局。
 * 调用方须先经长按确认（SPEC §8.2）。
 */
export function clearNames() {
  throw new Error('未实现');
}
