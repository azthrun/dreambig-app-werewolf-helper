/**
 * app.js — 应用入口、状态容器、渲染、事件绑定
 * SPEC §3.3 / §4 / §8 / §12 / §14
 *
 * 职责边界：
 *   · engine.js  —— 纯函数推算（结算、触发、信息、随机）
 *   · storage.js —— 持久化
 *   · app.js     —— 状态持有、副作用、DOM 渲染、手势
 *
 * ⚠️ 尚未实现 —— 仅为结构骨架。
 */

import {
  ROLES, ROLE_MAP, WOLF_ROLE_IDS, STEP_META, DEFAULT_NIGHT_ORDER,
  DEATH_REASONS, PRESETS, DEFAULT_RULES, DEFAULT_SETTINGS,
} from './roles.js';

import {
  resolveDawn, buildTriggerQueue, cascadeDeaths, computeStepInfo,
  bearGrowls, validateAction, activeNightSteps, campCounts,
  pickFirstSpeaker, nextAliveSeat,
} from './engine.js';

import {
  saveGame, loadGame, clearGame, pendingGameSummary,
  loadNames, rememberNames, clearNames, STATE_VERSION,
} from './storage.js';

// ══════════════════════════════════════════════════════════════════
// 常量
// ══════════════════════════════════════════════════════════════════

const LONG_PRESS_DESTRUCTIVE_MS = 600;  // 破坏性操作长按守护（SPEC §8.2）
const LONG_PRESS_DEATH_MS = 550;        // 长按标记阵亡（SPEC §8.3）
const UNDO_BAR_MS = 5000;               // 撤销条驻留时长（SPEC §8.2）
const HISTORY_DEPTH = 20;               // 全量快照深度（SPEC §8.5）
const MIN_PLAYERS = 6;
const MAX_PLAYERS = 20;

// ══════════════════════════════════════════════════════════════════
// 状态容器
// ══════════════════════════════════════════════════════════════════

/** @type {GameState} */
let state = null;

/** 建立初始状态。SPEC §3.3 */
function createInitialState() {
  throw new Error('未实现');
}

/**
 * 唯一的状态写入口：推入全量快照 → 应用变更 → 持久化 → 重渲染。
 * SPEC §8.5 —— 快照必须是完整 GameState，而非仅 players + log。
 * @param {Partial<GameState>|((s:GameState)=>Partial<GameState>)} patch
 * @param {{ snapshot?: boolean }} [opts]
 */
function update(patch, opts = {}) {
  throw new Error('未实现');
}

/** 撤销至上一快照。SPEC §8.5 */
function undo() {
  throw new Error('未实现');
}

// ══════════════════════════════════════════════════════════════════
// 渲染
// ══════════════════════════════════════════════════════════════════

/** 依 state.screen 切换屏幕并渲染。 */
function render() {
  throw new Error('未实现');
}

function renderSetup1() { throw new Error('未实现'); }   // SPEC §4.1
function renderSetup2() { throw new Error('未实现'); }   // SPEC §4.1 / §11.2
function renderSetup3() { throw new Error('未实现'); }   // SPEC §4.1 / §7
function renderSetup4() { throw new Error('未实现'); }   // SPEC §4.1 / §8.4
function renderGame()   { throw new Error('未实现'); }   // SPEC §12.1
function renderLog()    { throw new Error('未实现'); }   // SPEC §16
function renderReport() { throw new Error('未实现'); }   // SPEC §4.4

/**
 * 玩家网格。列数随人数自适应：≤9→3、10–16→4、17–20→5。
 * 阵亡卡片折叠至 ~42px。SPEC §12.2
 */
function renderPlayerGrid() { throw new Error('未实现'); }

// ══════════════════════════════════════════════════════════════════
// 流程 —— 夜晚
// ══════════════════════════════════════════════════════════════════

function beginNight()          { throw new Error('未实现'); }  // SPEC §4.2
function confirmNightStep()    { throw new Error('未实现'); }
function skipNightStep()       { throw new Error('未实现'); }
function selectStepTarget(seat){ throw new Error('未实现'); }  // 含身份隐式补全 §8.4

/** 天亮：调用 resolveDawn，呈现可增删的死亡提案。SPEC §5.1 */
function endNight() { throw new Error('未实现'); }

// ══════════════════════════════════════════════════════════════════
// 流程 —— 白天
// ══════════════════════════════════════════════════════════════════

function confirmPendingDeaths()  { throw new Error('未实现'); }  // SPEC §4.3
function processTriggerQueue()   { throw new Error('未实现'); }  // SPEC §5.4
function resolveTrigger(payload) { throw new Error('未实现'); }
function startDuel()             { throw new Error('未实现'); }  // 骑士决斗
function whiteWolfSelfDestruct() { throw new Error('未实现'); }  // 白狼王自爆带人
function wolfSelfDestruct(seat)  { throw new Error('未实现'); }  // 普通狼人自爆
function endDay()                { throw new Error('未实现'); }

// ══════════════════════════════════════════════════════════════════
// 死亡与复活
// ══════════════════════════════════════════════════════════════════

/** 标记阵亡；产生的死亡回流 cascadeDeaths。SPEC §5.4 */
function markDead(seat, reason) { throw new Error('未实现'); }

/** 复活。经点击展开卡片后的按钮触发，不与长按共用手势。SPEC §8.3 */
function revive(seat) { throw new Error('未实现'); }

// ══════════════════════════════════════════════════════════════════
// 计时器 —— 以截止时间戳存储，不使用递减整数。SPEC §14.1
// ══════════════════════════════════════════════════════════════════

function timerStart(seconds)        { throw new Error('未实现'); }
function timerPause()               { throw new Error('未实现'); }
function timerAdjust(deltaSeconds)  { throw new Error('未实现'); }
function timerRemainingMs()         { throw new Error('未实现'); }
function startSpeechTimer(seat, dir){ throw new Error('未实现'); }  // SPEC §14.2
function speechNext()               { throw new Error('未实现'); }
function speechPrev()               { throw new Error('未实现'); }

// ══════════════════════════════════════════════════════════════════
// 警报通道 —— 视觉优先，震动为渐进增强（iOS 不支持）。SPEC §10
// ══════════════════════════════════════════════════════════════════

/** 常驻警告横幅，需法官点击「知道了」确认，不自动消失。 */
function raiseAlert(type, seat, text) { throw new Error('未实现'); }
function dismissAlert()               { throw new Error('未实现'); }

// ══════════════════════════════════════════════════════════════════
// 手势
// ══════════════════════════════════════════════════════════════════

/** 长按守护（600ms + 进度反馈），用于破坏性操作。SPEC §8.2 */
function bindLongPressGuard(el, onConfirm) { throw new Error('未实现'); }

/** 长按 550ms 标记阵亡 → 内联死因芯片。SPEC §8.3 */
function bindDeathLongPress(el, seat) { throw new Error('未实现'); }

/** 先执行 + 撤销条（~5s）。SPEC §8.2 */
function showUndoBar(text) { throw new Error('未实现'); }

/**
 * 把手拖拽排序，基于 Pointer Events（HTML5 DnD 在触摸设备不可用）。
 * 供 Step 2 姓名排序与 Step 3 夜晚顺序共用。SPEC §4.1
 * @param {HTMLElement} container
 * @param {(from:number, to:number) => void} onReorder
 */
function bindDragReorder(container, onReorder) { throw new Error('未实现'); }

// ══════════════════════════════════════════════════════════════════
// 日志
// ══════════════════════════════════════════════════════════════════

/** 追加类型化事件。SPEC §3.4 / §16.1 */
function addLog(type, text, extra = {}) { throw new Error('未实现'); }
function addNote(text)                  { throw new Error('未实现'); }
function deleteNote(index)              { throw new Error('未实现'); }
function exportLogText()                { throw new Error('未实现'); }  // 复制到剪贴板

// ══════════════════════════════════════════════════════════════════
// 平台能力
// ══════════════════════════════════════════════════════════════════

/** 对局进行中申请屏幕常亮，结束时释放。不支持则静默失败。SPEC §12.3 */
async function requestWakeLock() { throw new Error('未实现'); }
function releaseWakeLock()       { throw new Error('未实现'); }

/** 主题：auto / light / dark；局内默认暗色。SPEC §12.4 */
function applyTheme(theme) { throw new Error('未实现'); }

/** 注册 Service Worker。SPEC §13.2 */
function registerServiceWorker() { throw new Error('未实现'); }

// ══════════════════════════════════════════════════════════════════
// 启动
// ══════════════════════════════════════════════════════════════════

function boot() {
  throw new Error('未实现');
  // 1. applyTheme
  // 2. state = loadGame() ?? createInitialState()   —— 版本不匹配则丢弃
  // 3. 若存在未完成对局 → Step 1 显示恢复横幅（不静默恢复，SPEC §11.1）
  // 4. 绑定全局事件
  // 5. render()
  // 6. registerServiceWorker()
}

boot();
