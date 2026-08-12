/**
 * app.js — 应用入口、状态容器、渲染、事件绑定
 * SPEC §3.3 / §4 / §8 / §12 / §14
 *
 * 职责边界：
 *   · engine.js  —— 纯函数推算（结算、触发、信息、随机）
 *   · storage.js —— 持久化
 *   · app.js     —— 状态持有、副作用、DOM 渲染、手势
 *
 * 本票（#7）范围：状态容器（唯一写入口 / 撤销 / 版本化持久化）、
 * 屏幕路由、设置 Step 1（人数与角色牌）、主题应用。
 * Step 2–4、局内网格、夜晚/白天流程、计时器、日志、战报等留给
 * #8–#17，此处仅提供可路由到达的最小占位屏，不实现其内容。
 */

import {
  ROLES, ROLE_MAP, WOLF_ROLE_IDS, STEP_META, DEFAULT_NIGHT_ORDER,
  DEATH_REASONS, PRESETS, DEFAULT_RULES, DEFAULT_SETTINGS,
  CAMP, CAMP_NAME,
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

const SCREENS = ['setup1', 'setup2', 'setup3', 'setup4', 'game', 'log', 'report'];
const THEME_LABEL = { auto: '自动', light: '浅色', dark: '深色' };

// ══════════════════════════════════════════════════════════════════
// 状态容器
// ══════════════════════════════════════════════════════════════════

/** @type {GameState} */
let state = null;

/** 存在但尚未确认续接的存档（SPEC §11.1 —— 不静默恢复）。 */
let pendingResume = null;

// ── Step 4 身份分配 —— 纯 UI 选择状态，不入 GameState/撤销栈 ──
let identitySelectedSeat = null;   // 当前待分配身份的座位
let loverPairMode = false;         // 「设为情侣」模式是否开启
let loverPairFirstSeat = null;     // 情侣配对已选中的第一个座位

/** 建立初始状态。SPEC §3.3 */
function createInitialState() {
  return {
    version: STATE_VERSION,
    screen: 'setup1',
    playerCount: 12,
    roleCounts: {},
    players: [],
    nightOrder: [...DEFAULT_NIGHT_ORDER],
    rules: { ...DEFAULT_RULES },
    settings: { ...DEFAULT_SETTINGS },
    day: 1,
    phase: 'night',
    stepIndex: 0,
    nightActions: {},
    lastGuardTarget: null,
    pendingDeaths: [],
    triggerQueue: [],
    timer: {
      mode: 'free',
      endsAt: null,
      pausedRemaining: null,
      running: false,
      speechSeat: null,
      speechDirection: 1,
    },
    log: [],
    history: [],
    alert: null,
  };
}

/** 建立空白玩家。SPEC §3.2 —— roleId 为 null 即「未知身份」，渐进填充见 §8.4 */
function createPlayer(seat) {
  return {
    seat,
    name: '',
    roleId: null,
    effectiveRoleId: null,
    alive: true,
    deathReason: null,
    deathDay: null,
    deathPhase: null,
    loverSeat: null,
    charmedBySeat: null,
    isSheriff: false,
    skills: {},
    flags: { idiotRevealed: false, foxDisabled: false },
  };
}

/** 深拷贝快照，剔除自身的 history 字段以避免无限嵌套。SPEC §8.5 */
function cloneStateForHistory(s) {
  const { history, ...rest } = s;
  return JSON.parse(JSON.stringify(rest));
}

/**
 * 唯一的状态写入口：推入全量快照 → 应用变更 → 持久化 → 重渲染。
 * SPEC §8.5 —— 快照必须是完整 GameState，而非仅 players + log。
 * @param {Partial<GameState>|((s:GameState)=>Partial<GameState>)} patch
 * @param {{ snapshot?: boolean }} [opts] snapshot=false 用于导航等不入撤销栈的变更
 */
function update(patch, opts = {}) {
  const { snapshot = true } = opts;
  const patchObj = typeof patch === 'function' ? patch(state) : patch;

  let history = state.history;
  if (snapshot) {
    history = [...state.history, cloneStateForHistory(state)].slice(-HISTORY_DEPTH);
  }

  state = { ...state, ...patchObj };
  // 整体替换 state 的调用（如续接存档、重置）会自带正确的 history，不应被覆盖
  if (!('history' in patchObj)) {
    state.history = history;
  }

  saveGame(state);
  render();
}

/** 撤销至上一快照。SPEC §8.5 */
function undo() {
  if (!state.history.length) return;
  const restored = state.history[state.history.length - 1];
  const remaining = state.history.slice(0, -1);
  state = { ...restored, history: remaining };
  saveGame(state);
  render();
}

// ══════════════════════════════════════════════════════════════════
// 渲染
// ══════════════════════════════════════════════════════════════════

/** 依 state.screen 切换屏幕并渲染。 */
function render() {
  for (const s of SCREENS) {
    const el = document.getElementById(`screen-${s}`);
    if (el) el.hidden = s !== state.screen;
  }
  switch (state.screen) {
    case 'setup1': renderSetup1(); break;
    case 'setup2': renderSetup2(); break;
    case 'setup3': renderSetup3(); break;
    case 'setup4': renderSetup4(); break;
    case 'game':   renderGame();   break;
    case 'log':    renderLog();    break;
    case 'report': renderReport(); break;
  }
}

/** 设置 Step 1 —— 人数与角色牌配置。SPEC §4.1 */
function renderSetup1() {
  const host = document.getElementById('screen-setup1');
  if (!host) return;

  const selected = Object.values(state.roleCounts).reduce((a, b) => a + b, 0);
  const mismatch = selected !== state.playerCount;

  const bannerHtml = pendingResume ? `
    <div class="banner-inline" role="status">
      <span>检测到未完成的对局（第${pendingResume.day}${pendingResume.phase === 'night' ? '晚' : '天'}） · 继续 / 放弃</span>
      <div class="banner-actions">
        <button type="button" class="btn btn-secondary" data-action="resume-game">继续</button>
        <button type="button" class="btn btn-secondary btn-longpress" data-action="discard-game" data-longpress="true">
          <span>放弃</span>
        </button>
      </div>
    </div>
  ` : '';

  const themeHtml = `
    <div class="theme-switch" role="group" aria-label="主题">
      ${['auto', 'light', 'dark'].map(t => `
        <button type="button"
                class="btn btn-ghost btn-sm${state.settings.theme === t ? ' is-active' : ''}"
                data-action="set-theme" data-theme="${t}">${THEME_LABEL[t]}</button>
      `).join('')}
    </div>
  `;

  const rolesHtml = [CAMP.WOLF, CAMP.GOD, CAMP.CIV].map(camp => `
    <div class="camp-group">
      <h3 class="camp-group-title">${CAMP_NAME[camp]}</h3>
      ${ROLES.filter(r => r.camp === camp).map(r => `
        <div class="role-row">
          <span class="role-row-name">${r.name}</span>
          <div class="stepper">
            <button type="button" class="btn btn-icon" data-action="role-dec" data-role="${r.id}" aria-label="减少${r.name}">−</button>
            <span class="stepper-value">${state.roleCounts[r.id] ?? 0}</span>
            <button type="button" class="btn btn-icon" data-action="role-inc" data-role="${r.id}" aria-label="增加${r.name}">+</button>
          </div>
        </div>
      `).join('')}
    </div>
  `).join('');

  host.innerHTML = `
    <div class="setup-screen">
      ${bannerHtml}
      <header class="setup-header">
        <h1>局型配置</h1>
        ${themeHtml}
      </header>

      <div class="field-row">
        <span class="field-label">人数</span>
        <div class="stepper">
          <button type="button" class="btn btn-icon" data-action="player-count-dec" aria-label="减少人数">−</button>
          <span class="stepper-value">${state.playerCount}</span>
          <button type="button" class="btn btn-icon" data-action="player-count-inc" aria-label="增加人数">+</button>
        </div>
      </div>

      <div class="preset-row">
        <button type="button" class="btn btn-secondary" data-action="apply-preset" data-preset="9">9人标准局</button>
        <button type="button" class="btn btn-secondary" data-action="apply-preset" data-preset="12">12人标准局</button>
        <button type="button" class="btn btn-secondary btn-longpress" data-action="clear-roles" data-longpress="true">
          <span>清空角色配置</span>
        </button>
      </div>

      <div class="role-groups">${rolesHtml}</div>

      <div class="setup-footer">
        <span class="tag${mismatch ? ' tag-accent' : ''}">已选 ${selected} / 需 ${state.playerCount} 人</span>
        <button type="button" class="btn btn-primary btn-block" data-action="goto-setup2">下一步</button>
      </div>
    </div>
  `;

  bindLongPressGuard(host.querySelector('[data-action="discard-game"]'), discardPendingGame);
  bindLongPressGuard(host.querySelector('[data-action="clear-roles"]'), clearRoleCounts);
}

/** 设置 Step 2 —— 玩家名单。内容详见 #8，此处仅提供可达占位屏。 */
function renderSetup2() {
  const host = document.getElementById('screen-setup2');
  if (!host) return;
  host.innerHTML = `
    <div class="wrap">
      <h1>玩家名单</h1>
      <p class="note">名单、拖拽排序与姓名池见票 #8。</p>
      <div class="actions">
        <button type="button" class="btn btn-secondary" data-action="goto-setup1">‹ 上一步</button>
        <button type="button" class="btn btn-primary" data-action="goto-setup3">下一步 ›</button>
      </div>
    </div>
  `;
}

/** 设置 Step 3 —— 夜晚顺序、计时、高级规则。内容详见 #8。 */
function renderSetup3() {
  const host = document.getElementById('screen-setup3');
  if (!host) return;
  host.innerHTML = `
    <div class="wrap">
      <h1>夜晚顺序与计时</h1>
      <p class="note">顺序拖拽、计时默认值与高级规则见票 #8。</p>
      <div class="actions">
        <button type="button" class="btn btn-secondary" data-action="goto-setup2">‹ 上一步</button>
        <button type="button" class="btn btn-primary" data-action="goto-setup4">下一步 ›</button>
      </div>
    </div>
  `;
}

/** 设置 Step 4 —— 分配身份。紧凑网格：点座位 → 点角色。SPEC §4.1 / §8.4 */
function renderSetup4() {
  const host = document.getElementById('screen-setup4');
  if (!host) return;

  const assigned = state.players.filter(p => p.roleId).length;
  const assignedByRole = {};
  for (const p of state.players) {
    if (p.roleId) assignedByRole[p.roleId] = (assignedByRole[p.roleId] ?? 0) + 1;
  }

  const seatsHtml = state.players.map(p => {
    const role = p.roleId ? ROLE_MAP[p.roleId] : null;
    const isPicking = identitySelectedSeat === p.seat || loverPairFirstSeat === p.seat;
    const loverTag = p.loverSeat != null ? `<span class="tag tag-outline">💕${p.loverSeat}号</span>` : '';
    return `
      <button type="button"
              class="player-card is-selectable${isPicking ? ' is-selected' : ''}"
              data-action="select-seat4" data-seat="${p.seat}">
        <span class="player-card-seat">${p.seat}号</span>
        <span class="player-card-name">${p.name || `座位${p.seat}`}</span>
        <span class="player-card-role">${role ? role.name : '未知身份'}</span>
        ${loverTag}
      </button>
    `;
  }).join('');

  const rolePickerHtml = identitySelectedSeat != null ? `
    <div class="banner-inline" role="status">
      <span>为 ${identitySelectedSeat}号 选择身份</span>
      <div class="banner-actions">
        <button type="button" class="btn btn-ghost btn-sm" data-action="clear-role4" data-seat="${identitySelectedSeat}">清除身份</button>
        <button type="button" class="btn btn-ghost btn-sm" data-action="select-seat4" data-seat="${identitySelectedSeat}">取消</button>
      </div>
    </div>
    <div class="role-groups">
      ${[CAMP.WOLF, CAMP.GOD, CAMP.CIV].map(camp => `
        <div class="camp-group">
          <h3 class="camp-group-title">${CAMP_NAME[camp]}</h3>
          ${ROLES.filter(r => r.camp === camp).map(r => {
            const remaining = (state.roleCounts[r.id] ?? 0) - (assignedByRole[r.id] ?? 0);
            return `
              <button type="button" class="role-row-select" data-action="assign-role4" data-role="${r.id}">
                <span class="role-row-name">${r.name}</span>
                <span class="tag${remaining <= 0 ? ' tag-outline' : ''}">剩余 ${remaining}</span>
              </button>
            `;
          }).join('')}
        </div>
      `).join('')}
    </div>
  ` : '';

  const loverBannerHtml = loverPairMode ? `
    <div class="banner-inline" role="status">
      <span>${loverPairFirstSeat == null ? '点选两名玩家建立情侣关系' : `已选 ${loverPairFirstSeat}号 · 再点选一名玩家`}</span>
      <div class="banner-actions">
        <button type="button" class="btn btn-ghost btn-sm" data-action="toggle-lover-mode">取消</button>
      </div>
    </div>
  ` : '';

  host.innerHTML = `
    <div class="setup-screen">
      <header class="setup-header">
        <h1>分配身份</h1>
        <span class="tag">已分配 ${assigned} / ${state.playerCount}</span>
      </header>

      <div class="preset-row">
        <button type="button" class="btn btn-secondary" data-action="assign-random-roles">随机分配剩余身份</button>
        <button type="button" class="btn btn-secondary${loverPairMode ? ' is-active' : ''}" data-action="toggle-lover-mode">设为情侣</button>
      </div>

      ${loverBannerHtml}

      <div class="player-grid" data-columns="${columnsForCount(state.playerCount)}">${seatsHtml}</div>

      ${rolePickerHtml}

      <div class="setup-footer">
        <div class="actions">
          <button type="button" class="btn btn-secondary" data-action="goto-setup3">‹ 上一步</button>
          <button type="button" class="btn btn-primary btn-block" data-action="start-game">开始游戏</button>
        </div>
      </div>
    </div>
  `;
}

/** 玩家网格列数：≤9→3、10–16→4、17–20→5。SPEC §12.2 */
function columnsForCount(n) {
  if (n <= 9) return 3;
  if (n <= 16) return 4;
  return 5;
}

/** 局内主界面。仅局头占位；网格与夜晚/白天流程见 #10–#13。SPEC §12.1 */
function renderGame() {
  const header = document.getElementById('game-header');
  if (!header) return;
  header.innerHTML = `
    <div class="wrap">
      <h1>第${state.day}${state.phase === 'night' ? '晚' : '天'}</h1>
      <p class="note">夜晚 / 白天流程与玩家网格见票 #10–#13。</p>
      <div class="actions">
        <button type="button" class="btn btn-icon" data-action="undo" aria-label="撤销">↶</button>
        <button type="button" class="btn btn-secondary" data-action="goto-log">日志</button>
        <button type="button" class="btn btn-secondary btn-longpress" data-action="end-game" data-longpress="true">
          <span>长按结束</span>
        </button>
      </div>
    </div>
  `;
  bindLongPressGuard(header.querySelector('[data-action="end-game"]'), () => update({ screen: 'report' }, { snapshot: false }));
}

/** 日志页。内容详见 #15。SPEC §16 */
function renderLog() {
  const host = document.getElementById('screen-log');
  if (!host) return;
  host.innerHTML = `
    <div class="wrap">
      <h1>日志</h1>
      <p class="note">分组浏览、筛选与导出见票 #15。</p>
      <div class="actions">
        <button type="button" class="btn btn-secondary" data-action="goto-game">‹ 返回</button>
      </div>
    </div>
  `;
}

/** 战报页。内容详见 #16。SPEC §4.4 */
function renderReport() {
  const host = document.getElementById('screen-report');
  if (!host) return;
  host.innerHTML = `
    <div class="wrap">
      <h1>战报</h1>
      <p class="note">胜负判定、完整名单与导出见票 #16。</p>
      <div class="actions">
        <button type="button" class="btn btn-secondary" data-action="goto-game">‹ 返回</button>
      </div>
    </div>
  `;
}

/**
 * 玩家网格。列数随人数自适应：≤9→3、10–16→4、17–20→5。
 * 阵亡卡片折叠至 ~42px。SPEC §12.2
 */
function renderPlayerGrid() { throw new Error('未实现'); }

// ══════════════════════════════════════════════════════════════════
// 设置 Step 1 —— 状态变更
// ══════════════════════════════════════════════════════════════════

function setPlayerCount(next) {
  const clamped = Math.min(MAX_PLAYERS, Math.max(MIN_PLAYERS, next));
  if (clamped === state.playerCount) return;
  update({ playerCount: clamped });
}

function adjustRoleCount(roleId, delta) {
  const current = state.roleCounts[roleId] ?? 0;
  const next = Math.max(0, current + delta);
  update({ roleCounts: { ...state.roleCounts, [roleId]: next } });
}

function applyPreset(n) {
  const preset = PRESETS[n];
  if (!preset) return;
  update({ playerCount: preset.playerCount, roleCounts: { ...preset.roleCounts } });
}

function clearRoleCounts() {
  update({ roleCounts: {} });
}

function resumeGame() {
  if (!pendingResume) return;
  const resumed = pendingResume;
  pendingResume = null;
  update(() => resumed, { snapshot: false });
}

function discardPendingGame() {
  clearGame();
  pendingResume = null;
  update(() => createInitialState(), { snapshot: false });
}

function setTheme(theme) {
  update({ settings: { ...state.settings, theme } }, { snapshot: false });
  applyTheme(theme);
}

function gotoScreen(screen) {
  update({ screen }, { snapshot: false });
}

// ══════════════════════════════════════════════════════════════════
// 设置 Step 4 —— 分配身份与开局
// ══════════════════════════════════════════════════════════════════

/**
 * 按 playerCount 补齐 players 数组（座位 1..N），保留已存在座位的数据。
 * Step 2（#8）尚未落地，姓名/排序留空，本票仅需座位与身份骨架存在。
 */
function ensurePlayers() {
  const bySeat = new Map(state.players.map(p => [p.seat, p]));
  const next = [];
  for (let seat = 1; seat <= state.playerCount; seat++) {
    next.push(bySeat.get(seat) ?? createPlayer(seat));
  }
  const changed = next.length !== state.players.length || next.some((p, i) => p !== state.players[i]);
  if (changed) update({ players: next }, { snapshot: false });
}

function enterSetup4() {
  ensurePlayers();
  identitySelectedSeat = null;
  loverPairMode = false;
  loverPairFirstSeat = null;
  gotoScreen('setup4');
}

function selectSeat4(seat) {
  if (loverPairMode) {
    handleLoverSeatClick(seat);
    return;
  }
  identitySelectedSeat = identitySelectedSeat === seat ? null : seat;
  render();
}

function assignRole4(roleId) {
  if (identitySelectedSeat == null) return;
  const seat = identitySelectedSeat;
  const players = state.players.map(p =>
    p.seat === seat ? { ...p, roleId, effectiveRoleId: roleId } : p);
  identitySelectedSeat = null;
  update({ players });
}

function clearRole4(seat) {
  const players = state.players.map(p =>
    p.seat === seat ? { ...p, roleId: null, effectiveRoleId: null } : p);
  identitySelectedSeat = null;
  update({ players });
}

/** 随机分配剩余身份。仅覆盖未分配座位与未分配满的角色。SPEC §4.1 Step4 */
function randomAssignRemainingRoles() {
  const assignedByRole = {};
  for (const p of state.players) {
    if (p.roleId) assignedByRole[p.roleId] = (assignedByRole[p.roleId] ?? 0) + 1;
  }
  const pool = [];
  for (const [roleId, count] of Object.entries(state.roleCounts)) {
    const remaining = count - (assignedByRole[roleId] ?? 0);
    for (let i = 0; i < remaining; i++) pool.push(roleId);
  }
  shuffleCrypto(pool);

  let i = 0;
  const players = state.players.map(p => {
    if (p.roleId != null) return p;
    const roleId = pool[i];
    if (roleId == null) return p;
    i++;
    return { ...p, roleId, effectiveRoleId: roleId };
  });
  identitySelectedSeat = null;
  update({ players });
}

/** Fisher–Yates，使用 crypto.getRandomValues。SPEC §4.1 Step4 */
function shuffleCrypto(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const buf = new Uint32Array(1);
    crypto.getRandomValues(buf);
    const j = buf[0] % (i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

function toggleLoverMode() {
  loverPairMode = !loverPairMode;
  loverPairFirstSeat = null;
  render();
}

/** 手动配对情侣：设置阶段点选两名玩家。SPEC §5.3 */
function handleLoverSeatClick(seat) {
  if (loverPairFirstSeat == null) {
    const player = state.players.find(p => p.seat === seat);
    if (player && player.loverSeat != null) {
      unpairLovers(seat);
      loverPairMode = false;
      render();
      return;
    }
    loverPairFirstSeat = seat;
    render();
    return;
  }
  if (loverPairFirstSeat === seat) {
    loverPairFirstSeat = null;
    render();
    return;
  }
  const firstSeat = loverPairFirstSeat;
  loverPairFirstSeat = null;
  loverPairMode = false;
  pairLovers(firstSeat, seat);
}

function pairLovers(seatA, seatB) {
  const players = state.players.map(p => {
    if (p.seat === seatA) return { ...p, loverSeat: seatB };
    if (p.seat === seatB) return { ...p, loverSeat: seatA };
    return p;
  });
  update({ players });
}

function unpairLovers(seat) {
  const player = state.players.find(p => p.seat === seat);
  if (!player || player.loverSeat == null) return;
  const otherSeat = player.loverSeat;
  const players = state.players.map(p =>
    (p.seat === seat || p.seat === otherSeat) ? { ...p, loverSeat: null } : p);
  update({ players });
}

/** 开始游戏：始终可点击，未分配座位进入局内后为未知身份。SPEC §4.1 Step4 / §4.2 */
function startGame() {
  const entry = {
    day: state.day,
    phase: state.phase,
    type: 'system',
    actor: null,
    targets: [],
    text: '游戏开始',
    result: null,
    ts: Date.now(),
  };
  identitySelectedSeat = null;
  loverPairMode = false;
  loverPairFirstSeat = null;
  update({ screen: 'game', log: [...state.log, entry] });
}

// ══════════════════════════════════════════════════════════════════
// 流程 —— 夜晚（#10–#13 范围，暂未实现）
// ══════════════════════════════════════════════════════════════════

function beginNight()          { throw new Error('未实现'); }  // SPEC §4.2
function confirmNightStep()    { throw new Error('未实现'); }
function skipNightStep()       { throw new Error('未实现'); }
function selectStepTarget(seat){ throw new Error('未实现'); }  // 含身份隐式补全 §8.4

/** 天亮：调用 resolveDawn，呈现可增删的死亡提案。SPEC §5.1 */
function endNight() { throw new Error('未实现'); }

// ══════════════════════════════════════════════════════════════════
// 流程 —— 白天（#13 范围，暂未实现）
// ══════════════════════════════════════════════════════════════════

function confirmPendingDeaths()  { throw new Error('未实现'); }  // SPEC §4.3
function processTriggerQueue()   { throw new Error('未实现'); }  // SPEC §5.4
function resolveTrigger(payload) { throw new Error('未实现'); }
function startDuel()             { throw new Error('未实现'); }  // 骑士决斗
function whiteWolfSelfDestruct() { throw new Error('未实现'); }  // 白狼王自爆带人
function wolfSelfDestruct(seat)  { throw new Error('未实现'); }  // 普通狼人自爆
function endDay()                { throw new Error('未实现'); }

// ══════════════════════════════════════════════════════════════════
// 死亡与复活（#10 范围，暂未实现）
// ══════════════════════════════════════════════════════════════════

/** 标记阵亡；产生的死亡回流 cascadeDeaths。SPEC §5.4 */
function markDead(seat, reason) { throw new Error('未实现'); }

/** 复活。经点击展开卡片后的按钮触发，不与长按共用手势。SPEC §8.3 */
function revive(seat) { throw new Error('未实现'); }

// ══════════════════════════════════════════════════════════════════
// 计时器（#14 范围，暂未实现）—— 以截止时间戳存储，不使用递减整数。SPEC §14.1
// ══════════════════════════════════════════════════════════════════

function timerStart(seconds)        { throw new Error('未实现'); }
function timerPause()               { throw new Error('未实现'); }
function timerAdjust(deltaSeconds)  { throw new Error('未实现'); }
function timerRemainingMs()         { throw new Error('未实现'); }
function startSpeechTimer(seat, dir){ throw new Error('未实现'); }  // SPEC §14.2
function speechNext()               { throw new Error('未实现'); }
function speechPrev()               { throw new Error('未实现'); }

// ══════════════════════════════════════════════════════════════════
// 警报通道（#12 范围，暂未实现）—— 视觉优先，震动为渐进增强。SPEC §10
// ══════════════════════════════════════════════════════════════════

/** 常驻警告横幅，需法官点击「知道了」确认，不自动消失。 */
function raiseAlert(type, seat, text) { throw new Error('未实现'); }
function dismissAlert()               { throw new Error('未实现'); }

// ══════════════════════════════════════════════════════════════════
// 手势
// ══════════════════════════════════════════════════════════════════

/** 长按守护（600ms + 进度反馈），用于破坏性操作。SPEC §8.2 */
function bindLongPressGuard(el, onConfirm) {
  if (!el) return;
  let timer = null;

  const clear = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    el.classList.remove('is-pressing');
  };

  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    el.classList.add('is-pressing');
    timer = setTimeout(() => {
      clear();
      onConfirm();
    }, LONG_PRESS_DESTRUCTIVE_MS);
  });
  el.addEventListener('pointerup', clear);
  el.addEventListener('pointerleave', clear);
  el.addEventListener('pointercancel', clear);
}

/** 长按 550ms 标记阵亡 → 内联死因芯片。SPEC §8.3（#10 范围，暂未实现） */
function bindDeathLongPress(el, seat) { throw new Error('未实现'); }

/** 先执行 + 撤销条（~5s）。SPEC §8.2（#10 范围，暂未实现） */
function showUndoBar(text) { throw new Error('未实现'); }

/**
 * 把手拖拽排序，基于 Pointer Events（HTML5 DnD 在触摸设备不可用）。
 * 供 Step 2 姓名排序与 Step 3 夜晚顺序共用。SPEC §4.1（#8 范围，暂未实现）
 * @param {HTMLElement} container
 * @param {(from:number, to:number) => void} onReorder
 */
function bindDragReorder(container, onReorder) { throw new Error('未实现'); }

// ══════════════════════════════════════════════════════════════════
// 事件委托
// ══════════════════════════════════════════════════════════════════

/**
 * 单一委托点击处理器（绑定于 #app）。长按守护按钮（data-longpress="true"）
 * 由 bindLongPressGuard 直接绑定，此处跳过以避免松开时的 click 误触发。
 */
function handleAppClick(e) {
  const el = e.target.closest('[data-action]');
  if (!el || el.dataset.longpress === 'true') return;

  const action = el.dataset.action;
  switch (action) {
    case 'player-count-dec': setPlayerCount(state.playerCount - 1); break;
    case 'player-count-inc': setPlayerCount(state.playerCount + 1); break;
    case 'apply-preset':     applyPreset(Number(el.dataset.preset)); break;
    case 'role-dec':         adjustRoleCount(el.dataset.role, -1); break;
    case 'role-inc':         adjustRoleCount(el.dataset.role, 1); break;
    case 'resume-game':      resumeGame(); break;
    case 'set-theme':        setTheme(el.dataset.theme); break;
    case 'goto-setup1':      gotoScreen('setup1'); break;
    case 'goto-setup2':      gotoScreen('setup2'); break;
    case 'goto-setup3':      gotoScreen('setup3'); break;
    case 'goto-setup4':      enterSetup4(); break;
    case 'goto-game':        gotoScreen('game'); break;
    case 'goto-log':         gotoScreen('log'); break;
    case 'undo':              undo(); break;
    case 'select-seat4':      selectSeat4(Number(el.dataset.seat)); break;
    case 'assign-role4':      assignRole4(el.dataset.role); break;
    case 'clear-role4':       clearRole4(Number(el.dataset.seat)); break;
    case 'assign-random-roles': randomAssignRemainingRoles(); break;
    case 'toggle-lover-mode': toggleLoverMode(); break;
    case 'start-game':        startGame(); break;
    default: break;
  }
}

// ══════════════════════════════════════════════════════════════════
// 日志（#15 范围，暂未实现）
// ══════════════════════════════════════════════════════════════════

/** 追加类型化事件。SPEC §3.4 / §16.1 */
function addLog(type, text, extra = {}) { throw new Error('未实现'); }
function addNote(text)                  { throw new Error('未实现'); }
function deleteNote(index)              { throw new Error('未实现'); }
function exportLogText()                { throw new Error('未实现'); }  // 复制到剪贴板

// ══════════════════════════════════════════════════════════════════
// 平台能力
// ══════════════════════════════════════════════════════════════════

/** 对局进行中申请屏幕常亮，结束时释放。不支持则静默失败。SPEC §12.3（#10 范围） */
async function requestWakeLock() { throw new Error('未实现'); }
function releaseWakeLock()       { throw new Error('未实现'); }

/** 主题：auto / light / dark；局内默认暗色。SPEC §12.4 */
function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === 'light' || theme === 'dark') {
    root.setAttribute('data-theme', theme);
  } else {
    root.removeAttribute('data-theme');
  }
}

/** 注册 Service Worker。SPEC §13.2（#17 范围，暂未实现） */
function registerServiceWorker() { throw new Error('未实现'); }

// ══════════════════════════════════════════════════════════════════
// 启动
// ══════════════════════════════════════════════════════════════════

function boot() {
  const saved = loadGame();
  const summary = pendingGameSummary();

  if (saved && summary) {
    // 已进入实际对局的存档：不静默恢复，Step 1 显示横幅由法官选择 SPEC §11.1
    pendingResume = saved;
    state = createInitialState();
  } else if (saved) {
    // 仍处于设置向导的存档：直接续接编辑（配置局型 → 刷新页面 → 配置仍在）
    state = saved;
  } else {
    state = createInitialState();
  }

  applyTheme(state.settings.theme);
  document.getElementById('app').addEventListener('click', handleAppClick);
  render();
}

boot();
