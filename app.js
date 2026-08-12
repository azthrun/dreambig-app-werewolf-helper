/**
 * app.js — 应用入口、状态容器、渲染、事件绑定
 * SPEC §3.3 / §4 / §8 / §12 / §14
 *
 * 职责边界：
 *   · engine.js  —— 纯函数推算（结算、触发、信息、随机）
 *   · storage.js —— 持久化
 *   · app.js     —— 状态持有、副作用、DOM 渲染、手势
 *
 * 状态容器（唯一写入口 / 撤销 / 版本化持久化）、屏幕路由、设置向导
 * 全部四步（人数与角色牌 #7、玩家名单与姓名池 #8、夜晚顺序与计时 #8、
 * 分配身份与开局 #9）与主题应用已实现。局内网格、夜晚/白天流程、计时器、
 * 日志、战报等留给 #10–#17，此处仅提供可路由到达的最小占位屏，不实现其内容。
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
const WITCH_SELF_SAVE_LABEL = { never: '不可', firstNightOnly: '仅首夜', always: '始终' };

/** 技能槽显示名（SPEC §6）。lastTarget 为连守记录，非消耗型，不作为状态芯片展示。 */
const SKILL_LABELS = {
  antidote: '解药', poison: '毒药', shot: '开枪', selfDestruct: '自爆',
  duel: '决斗', link: '连线', swap: '交换', copy: '复制',
};

const DAY_TIMER_STEP = 30;
const DAY_TIMER_MIN = 30;
const DAY_TIMER_MAX = 900;
const NIGHT_TIMER_STEP = 10;
const NIGHT_TIMER_MIN = 10;
const NIGHT_TIMER_MAX = 300;

// ══════════════════════════════════════════════════════════════════
// 状态容器
// ══════════════════════════════════════════════════════════════════

/** @type {GameState} */
let state = null;

/** 存在但尚未确认续接的存档（SPEC §11.1 —— 不静默恢复）。 */
let pendingResume = null;

/** 姓名池与上次名单（SPEC §11.2）—— 独立于 GameState 的生命周期。 */
let namePool = { pool: [], lastRoster: [] };

/** Step 3「高级规则」折叠区的展开状态 —— 纯 UI 瞬态，不入 GameState。默认收起。 */
let advancedRulesOpen = false;

// ── Step 4 身份分配 —— 纯 UI 选择状态，不入 GameState/撤销栈 ──
let identitySelectedSeat = null;   // 当前待分配身份的座位
let loverPairMode = false;         // 「设为情侣」模式是否开启（Step 4 与局内共用）
let loverPairFirstSeat = null;     // 情侣配对已选中的第一个座位

// ── 局内玩家网格 —— 纯 UI 展开状态，不入 GameState/撤销栈。SPEC §12 / §8.3 ──
let gameExpandedSeat = null;       // 当前展开信息面板的座位（存活或阵亡）
let gameDeathPickerSeat = null;    // 当前展示死因芯片的座位（长按触发）
let gameRoleEditSeat = null;       // 当前正在「修改身份」的座位

let undoBarTimer = null;           // 撤销条自动隐藏定时器
let wakeLockSentinel = null;       // Screen Wake Lock 句柄

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

/** 设置 Step 2 —— 玩家名单：座位 + 拖拽把手 + 姓名，姓名池，沿用上次名单。SPEC §4.1 / §11.2 */
function renderSetup2() {
  const host = document.getElementById('screen-setup2');
  if (!host) return;
  ensurePlayersSynced();

  const rosterHtml = state.players.map(p => `
    <div class="reorder-item name-row" data-seat="${p.seat}">
      <button type="button" class="drag-handle" aria-label="拖拽调整座位${p.seat}的姓名分配">⠿</button>
      <span class="player-card-seat">${p.seat}号</span>
      <input type="text" class="input" data-action="edit-name" data-seat="${p.seat}"
             value="${escapeAttr(p.name)}" placeholder="座位${p.seat}" maxlength="12" autocomplete="off">
      <div class="name-pool-chips" hidden>
        ${namePool.pool.length
          ? namePool.pool.map(n => `<button type="button" class="chip" data-action="fill-name" data-seat="${p.seat}" data-name="${escapeAttr(n)}">${escapeText(n)}</button>`).join('')
          : '<span class="note">暂无历史姓名</span>'}
      </div>
    </div>
  `).join('');

  const lastRosterHtml = namePool.lastRoster.length ? `
    <button type="button" class="btn btn-secondary" data-action="apply-last-roster">沿用上次名单</button>
  ` : '';

  host.innerHTML = `
    <div class="setup-screen">
      <header class="setup-header"><h1>玩家名单</h1></header>

      <div class="preset-row">
        ${lastRosterHtml}
        <button type="button" class="btn btn-secondary btn-longpress" data-action="clear-names" data-longpress="true">
          <span>清空已存姓名</span>
        </button>
      </div>

      <div class="reorder-list" id="name-reorder-list">${rosterHtml}</div>

      <div class="setup-footer">
        <div class="actions">
          <button type="button" class="btn btn-secondary" data-action="goto-setup1">‹ 上一步</button>
          <button type="button" class="btn btn-primary" data-action="goto-setup3">下一步 ›</button>
        </div>
      </div>
    </div>
  `;

  bindLongPressGuard(host.querySelector('[data-action="clear-names"]'), clearStoredNames);
  bindDragReorder(document.getElementById('name-reorder-list'), reorderPlayerNames);
}

/** 设置 Step 3 —— 夜晚顺序（复用拖拽组件）、计时默认值、高级规则折叠区。SPEC §4.1 / §7 */
function renderSetup3() {
  const host = document.getElementById('screen-setup3');
  if (!host) return;

  const activeSteps = activeNightStepsForSetup(state);
  const stepsHtml = activeSteps.length ? activeSteps.map(id => `
    <div class="reorder-item" data-step="${id}">
      <button type="button" class="drag-handle" aria-label="拖拽调整${STEP_META[id].name}顺序">⠿</button>
      <span class="reorder-item-label">${STEP_META[id].name}</span>
    </div>
  `).join('') : '<p class="note">当前局型没有夜晚行动步骤</p>';

  const rules = state.rules;
  const settings = state.settings;

  host.innerHTML = `
    <div class="setup-screen">
      <header class="setup-header"><h1>夜晚顺序与计时</h1></header>

      <div class="field-row">
        <span class="field-label">夜晚顺序</span>
        <button type="button" class="btn btn-secondary btn-sm" data-action="reset-night-order">恢复默认顺序</button>
      </div>
      <div class="reorder-list" id="night-order-list">${stepsHtml}</div>

      <div class="field-row">
        <span class="field-label">白天讨论默认时长</span>
        <div class="stepper">
          <button type="button" class="btn btn-icon" data-action="day-timer-dec" aria-label="减少白天讨论时长">−</button>
          <span class="stepper-value">${settings.dayTimerDefault}s</span>
          <button type="button" class="btn btn-icon" data-action="day-timer-inc" aria-label="增加白天讨论时长">+</button>
        </div>
      </div>
      <div class="field-row">
        <span class="field-label">夜晚行动默认时长</span>
        <div class="stepper">
          <button type="button" class="btn btn-icon" data-action="night-timer-dec" aria-label="减少夜晚行动时长">−</button>
          <span class="stepper-value">${settings.nightTimerDefault}s</span>
          <button type="button" class="btn btn-icon" data-action="night-timer-inc" aria-label="增加夜晚行动时长">+</button>
        </div>
      </div>

      <details class="advanced-rules" id="advanced-rules"${advancedRulesOpen ? ' open' : ''}>
        <summary>高级规则</summary>

        <div class="toggle-row">
          <span class="toggle-row-label">同守同救结果 → 死亡</span>
          <label class="switch"><input type="checkbox" data-action="toggle-rule" data-rule="doubleProtectKills" ${rules.doubleProtectKills ? 'checked' : ''}></label>
        </div>

        <div class="toggle-row">
          <span class="toggle-row-label">女巫自救</span>
          <div class="segmented" role="group" aria-label="女巫自救">
            ${['never', 'firstNightOnly', 'always'].map(v => `
              <button type="button" class="btn btn-ghost btn-sm${rules.witchSelfSave === v ? ' is-active' : ''}"
                      data-action="set-witch-self-save" data-value="${v}">${WITCH_SELF_SAVE_LABEL[v]}</button>
            `).join('')}
          </div>
        </div>

        <div class="toggle-row">
          <span class="toggle-row-label">允许守卫连守</span>
          <label class="switch"><input type="checkbox" data-action="toggle-rule" data-rule="guardRepeatAllowed" ${rules.guardRepeatAllowed ? 'checked' : ''}></label>
        </div>

        <div class="toggle-row">
          <span class="toggle-row-label">非常规死亡抑制开枪</span>
          <label class="switch"><input type="checkbox" data-action="toggle-rule" data-rule="abnormalDeathBlocksShot" ${rules.abnormalDeathBlocksShot ? 'checked' : ''}></label>
        </div>

        <div class="toggle-row">
          <span class="toggle-row-label">女巫同夜可双药</span>
          <label class="switch"><input type="checkbox" data-action="toggle-rule" data-rule="witchBothPotions" ${rules.witchBothPotions ? 'checked' : ''}></label>
        </div>

        <div class="toggle-row">
          <span class="toggle-row-label">每日随机首发言</span>
          <label class="switch"><input type="checkbox" data-action="toggle-setting" data-setting="randomFirstSpeaker" ${settings.randomFirstSpeaker ? 'checked' : ''}></label>
        </div>

        <div class="toggle-row">
          <span class="toggle-row-label">提示音</span>
          <label class="switch"><input type="checkbox" data-action="toggle-setting" data-setting="soundEnabled" ${settings.soundEnabled ? 'checked' : ''}></label>
        </div>
      </details>

      <div class="setup-footer">
        <div class="actions">
          <button type="button" class="btn btn-secondary" data-action="goto-setup2">‹ 上一步</button>
          <button type="button" class="btn btn-primary" data-action="goto-setup4">下一步 ›</button>
        </div>
      </div>
    </div>
  `;

  bindDragReorder(document.getElementById('night-order-list'), reorderNightSteps);
  host.querySelector('#advanced-rules').addEventListener('toggle', (e) => {
    advancedRulesOpen = e.target.open;
  });
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

/** 局内主界面：固定控制区 + 步骤区 + 可滚动玩家网格 + 撤销条。SPEC §12.1 */
function renderGame() {
  renderGameHeader();
  renderPhasePanel();
  renderPlayerGrid();
}

/** 固定控制区：阶段标题 + 撤销 / 日志 / 长按结束。SPEC §12.1（计时器 / 阵营计数见 #11–#14） */
function renderGameHeader() {
  const header = document.getElementById('game-header');
  if (!header) return;
  header.innerHTML = `
    <div class="game-header-row">
      <h1 class="game-header-title">第${state.day}${state.phase === 'night' ? '晚' : '天'}</h1>
      <div class="actions">
        <button type="button" class="btn btn-icon" data-action="undo" aria-label="撤销">↶</button>
        <button type="button" class="btn btn-secondary" data-action="goto-log">日志</button>
        <button type="button" class="btn btn-secondary btn-longpress" data-action="end-game" data-longpress="true">
          <span>长按结束</span>
        </button>
      </div>
    </div>
  `;
  bindLongPressGuard(header.querySelector('[data-action="end-game"]'), () => {
    releaseWakeLock();
    hideUndoBar();
    update({ screen: 'report' }, { snapshot: false });
  });
}

/** 固定步骤区。夜晚 / 白天流程内容见 #11–#13；此处仅承载「设为情侣」配对提示。SPEC §12.1 */
function renderPhasePanel() {
  const panel = document.getElementById('phase-panel');
  if (!panel) return;
  if (loverPairMode) {
    panel.innerHTML = `
      <div class="banner-inline" role="status">
        <span>${loverPairFirstSeat == null ? '点选两名玩家建立情侣关系' : `已选 ${loverPairFirstSeat}号 · 再点选一名玩家`}</span>
        <div class="banner-actions">
          <button type="button" class="btn btn-ghost btn-sm" data-action="toggle-lover-mode">取消</button>
        </div>
      </div>
    `;
    return;
  }
  panel.innerHTML = `<p class="note">夜晚 / 白天流程见票 #11–#13。</p>`;
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
function renderPlayerGrid() {
  const grid = document.getElementById('player-grid');
  if (!grid) return;
  const columns = columnsForCount(state.playerCount);
  grid.dataset.columns = String(columns);
  grid.innerHTML = state.players.map(p => renderPlayerCard(p, columns)).join('');

  // 长按 550ms 标记阵亡，仅绑定于折叠态的存活卡片。SPEC §8.3
  grid.querySelectorAll('button.player-card:not(.is-dead)').forEach(el => {
    bindDeathLongPress(el, Number(el.dataset.seat));
  });
}

/** 单张玩家卡片：折叠 / 展开态，按存活与人数密度分派。SPEC §12.2 / §8.3 */
function renderPlayerCard(p, columns) {
  const role = p.roleId ? ROLE_MAP[p.roleId] : null;
  const roleName = role ? role.name : '未知身份';
  const displayName = escapeText(p.name || `${p.seat}号`);

  if (gameRoleEditSeat === p.seat) {
    return `
      <div class="player-card player-card-expanded" data-seat="${p.seat}">
        <div class="player-card-expanded-header" data-action="toggle-alive-expand" data-seat="${p.seat}">
          <span class="player-card-seat">${p.seat}号 ${displayName}</span>
        </div>
        <div class="player-card-expanded-body">
          ${renderRoleEditPanelHtml(p.seat)}
        </div>
      </div>
    `;
  }

  if (gameDeathPickerSeat === p.seat) {
    return `
      <div class="player-card player-card-expanded" data-seat="${p.seat}">
        <div class="player-card-expanded-header">
          <span class="player-card-seat">${p.seat}号 ${displayName} · 标记阵亡</span>
          <button type="button" class="btn btn-ghost btn-sm" data-action="cancel-death-picker">取消</button>
        </div>
        <div class="death-reason-chips">
          ${DEATH_REASONS.map(r => `
            <button type="button" class="chip" data-action="mark-dead" data-seat="${p.seat}" data-reason="${escapeAttr(r)}">${escapeText(r)}</button>
          `).join('')}
        </div>
      </div>
    `;
  }

  if (!p.alive) {
    if (gameExpandedSeat === p.seat) {
      return `
        <div class="player-card player-card-expanded is-dead" data-seat="${p.seat}">
          <div class="player-card-expanded-header" data-action="toggle-alive-expand" data-seat="${p.seat}">
            <span class="player-card-seat">${p.seat}号 ${displayName}</span>
          </div>
          <div class="player-card-expanded-body">
            <span class="player-card-role">${escapeText(roleName)}</span>
            <span class="tag tag-accent">${escapeText(p.deathReason || '其他')}</span>
            <div class="player-card-expanded-actions">
              <button type="button" class="btn btn-primary btn-sm" data-action="revive-game" data-seat="${p.seat}">恢复存活</button>
            </div>
          </div>
        </div>
      `;
    }
    return `
      <button type="button" class="player-card is-dead" data-action="toggle-alive-expand" data-seat="${p.seat}">
        <span class="player-card-seat">${p.seat}号</span>
        <span class="player-card-name">${displayName}</span>
        <span class="player-card-role">${escapeText(roleName)}</span>
        ${p.deathReason ? `<span class="tag">${escapeText(p.deathReason)}</span>` : ''}
      </button>
    `;
  }

  if (gameExpandedSeat === p.seat) {
    const loverActionHtml = p.loverSeat != null
      ? `<button type="button" class="btn btn-ghost btn-sm" data-action="unpair-lover-game" data-seat="${p.seat}">解除情侣（与 ${p.loverSeat}号）</button>`
      : `<button type="button" class="btn btn-secondary btn-sm" data-action="set-lover-game" data-seat="${p.seat}">设为情侣</button>`;
    return `
      <div class="player-card player-card-expanded" data-seat="${p.seat}">
        <div class="player-card-expanded-header" data-action="toggle-alive-expand" data-seat="${p.seat}">
          <span class="player-card-seat">${p.seat}号 ${displayName}</span>
          <span class="player-card-role">${escapeText(roleName)}</span>
        </div>
        <div class="player-card-expanded-body">
          ${renderSkillStatusHtml(p, role)}
          <div class="player-card-expanded-actions">
            <button type="button" class="btn btn-secondary btn-sm" data-action="edit-role-game" data-seat="${p.seat}">修改身份</button>
            ${loverActionHtml}
          </div>
        </div>
      </div>
    `;
  }

  return `
    <button type="button" class="player-card" data-action="toggle-alive-expand" data-seat="${p.seat}">
      ${renderCardBodyByDensity(p, role, columns)}
    </button>
  `;
}

/** 折叠态存活卡片内容，随列数密度降级。SPEC §12.2 */
function renderCardBodyByDensity(p, role, columns) {
  const displayName = escapeText(p.name || `${p.seat}号`);
  const iconHtml = role
    ? `<svg class="player-card-icon" aria-hidden="true"><use href="#${role.icon}"></use></svg>`
    : '';
  const loverTag = p.loverSeat != null ? `<span class="tag tag-outline player-card-lover">💕${p.loverSeat}</span>` : '';

  if (columns === 5) {
    return `
      <span class="player-card-seat">${p.seat}</span>
      ${iconHtml}
      <span class="player-card-name">${displayName}</span>
      ${loverTag}
    `;
  }

  const roleName = role ? escapeText(role.name) : '未知身份';
  const skillChips = columns === 3 ? renderCompactSkillChips(p, role) : '';

  return `
    <span class="player-card-seat">${p.seat}号</span>
    ${iconHtml}
    <span class="player-card-name">${displayName}</span>
    <span class="player-card-role">${roleName}</span>
    ${loverTag}
    ${skillChips}
  `;
}

/** 折叠卡（仅 3 列密度）上的技能小标签，已用技能删除线 + 降低不透明度。SPEC §6 */
function renderCompactSkillChips(p, role) {
  if (!role || !role.skills.length) return '';
  const chips = role.skills.filter(key => key !== 'lastTarget').map(key => {
    const used = isSkillUsed(p, key);
    const label = SKILL_LABELS[key] ?? key;
    return `<span class="skill-chip${used ? ' is-used' : ''}">${escapeText(label)}</span>`;
  }).join('');
  return chips ? `<div class="skill-chip-row">${chips}</div>` : '';
}

/** 展开面板内的技能状态：图标标签 + ✓/✗。SPEC §6 */
function renderSkillStatusHtml(p, role) {
  if (!role || !role.skills.length) return '<p class="note">无可追踪技能</p>';
  const chips = role.skills.filter(key => key !== 'lastTarget').map(key => {
    const used = isSkillUsed(p, key);
    const label = SKILL_LABELS[key] ?? key;
    return `<span class="skill-chip${used ? ' is-used' : ''}">${escapeText(label)}${used ? ' ✗' : ' ✓'}</span>`;
  }).join('');
  return chips ? `<div class="skill-status-row">${chips}</div>` : '<p class="note">无可追踪技能</p>';
}

/** 技能槽是否已耗尽。白痴翻牌 / 狐狸失效记录于 flags，其余记录于 skills。SPEC §6 */
function isSkillUsed(p, key) {
  if (key === 'revealed') return !!p.flags?.idiotRevealed;
  if (key === 'active') return !!p.flags?.foxDisabled;
  return p.skills?.[key] === false;
}

/** 「修改身份」内联面板：与 Step 4 身份选择同款分组列表。SPEC §8.4 */
function renderRoleEditPanelHtml(seat) {
  const assignedByRole = {};
  for (const p of state.players) {
    if (p.roleId) assignedByRole[p.roleId] = (assignedByRole[p.roleId] ?? 0) + 1;
  }
  return `
    <div class="banner-inline" role="status">
      <span>为 ${seat}号 选择身份</span>
      <div class="banner-actions">
        <button type="button" class="btn btn-ghost btn-sm" data-action="clear-role-game" data-seat="${seat}">清除身份</button>
        <button type="button" class="btn btn-ghost btn-sm" data-action="cancel-role-edit-game">取消</button>
      </div>
    </div>
    <div class="role-groups">
      ${[CAMP.WOLF, CAMP.GOD, CAMP.CIV].map(camp => `
        <div class="camp-group">
          <h3 class="camp-group-title">${CAMP_NAME[camp]}</h3>
          ${ROLES.filter(r => r.camp === camp).map(r => {
            const remaining = (state.roleCounts[r.id] ?? 0) - (assignedByRole[r.id] ?? 0);
            return `
              <button type="button" class="role-row-select" data-action="assign-role-game" data-role="${r.id}">
                <span class="role-row-name">${r.name}</span>
                <span class="tag${remaining <= 0 ? ' tag-outline' : ''}">剩余 ${remaining}</span>
              </button>
            `;
          }).join('')}
        </div>
      `).join('')}
    </div>
  `;
}

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
  resetGameUiState();
  update(() => resumed, { snapshot: false });
  if (resumed.screen === 'game') requestWakeLock();
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
// 设置 Step 2 —— 玩家名单
// ══════════════════════════════════════════════════════════════════

/** 使 state.players 与 state.playerCount 同步，保留已存在座位的数据。 */
function ensurePlayersSynced() {
  const count = state.playerCount;
  if (state.players.length === count && state.players.every((p, i) => p.seat === i + 1)) return;
  const players = [];
  for (let i = 0; i < count; i++) {
    const seat = i + 1;
    const existing = state.players.find(p => p.seat === seat);
    players.push(existing ?? createPlayer(seat));
  }
  state = { ...state, players };
  saveGame(state);
}

/** 输入框逐字符更新：不入历史栈、不整屏重渲染，避免打字时丢失焦点/光标。 */
function setPlayerNameSilently(seat, name) {
  const players = state.players.map(p => (p.seat === seat ? { ...p, name } : p));
  state = { ...state, players };
  saveGame(state);
}

/** 姓名池芯片点击填入：直接写值 + 收起芯片面板，不整屏重渲染。 */
function fillNameFromChip(seatStr, name) {
  const seat = Number(seatStr);
  setPlayerNameSilently(seat, name);
  const row = document.querySelector(`.name-row[data-seat="${seat}"]`);
  const input = row?.querySelector('[data-action="edit-name"]');
  if (input) input.value = name;
  row?.querySelector('.name-pool-chips')?.setAttribute('hidden', '');
}

/** 拖拽重排姓名在固定座位间的分配 —— 座位号本身不变。SPEC §4.1 */
function reorderPlayerNames(from, to) {
  if (from === to) return;
  const names = state.players.map(p => p.name);
  const moved = [...names];
  const [item] = moved.splice(from, 1);
  moved.splice(to, 0, item);
  const players = state.players.map((p, i) => ({ ...p, name: moved[i] }));
  update({ players });
}

/** 沿用上次名单 —— 一键回填。SPEC §11.2 */
function applyLastRoster() {
  const map = new Map(namePool.lastRoster.map(r => [r.seat, r.name]));
  const players = state.players.map(p => ({ ...p, name: map.has(p.seat) ? map.get(p.seat) : p.name }));
  update({ players });
}

/** 清空姓名池与上次名单（不影响进行中的对局）。经长按 600ms 确认。SPEC §8.2 / §11.2 */
function clearStoredNames() {
  clearNames();
  namePool = loadNames();
  render();
}

/** 开始游戏时把本局姓名并入姓名池并记录为上次名单。SPEC §11.2 */
function commitNamesToPool() {
  const roster = state.players.map(p => ({ seat: p.seat, name: p.name || '' }));
  rememberNames(roster);
  namePool = loadNames();
}

// ══════════════════════════════════════════════════════════════════
// 设置 Step 3 —— 夜晚顺序、计时默认值、高级规则
// ══════════════════════════════════════════════════════════════════

/**
 * 当前局型（roleCounts）中实际存在的夜晚步骤，依 nightOrder 排序。
 * 与 engine.js 的 activeNightSteps 不同：后者依据已分配的玩家身份判定，
 * 用于局内运行时；此处身份尚未分配（Step 4 在其之后），改依角色牌数量判定。
 */
function activeNightStepsForSetup(s) {
  const roleIds = Object.entries(s.roleCounts).filter(([, c]) => c > 0).map(([id]) => id);
  const stepIds = new Set();
  for (const roleId of roleIds) {
    const role = ROLE_MAP[roleId];
    if (role?.nightStep) stepIds.add(role.nightStep);
  }
  return s.nightOrder.filter(id => stepIds.has(id));
}

/** 拖拽重排夜晚顺序：仅重排当前可见的活跃步骤，映射回完整 nightOrder。 */
function reorderNightSteps(from, to) {
  if (from === to) return;
  const active = activeNightStepsForSetup(state);
  const moved = [...active];
  const [item] = moved.splice(from, 1);
  moved.splice(to, 0, item);
  let idx = 0;
  const nightOrder = state.nightOrder.map(id => (active.includes(id) ? moved[idx++] : id));
  update({ nightOrder });
}

function resetNightOrder() {
  update({ nightOrder: [...DEFAULT_NIGHT_ORDER] });
}

function adjustDayTimer(delta) {
  const next = Math.max(DAY_TIMER_MIN, Math.min(DAY_TIMER_MAX, state.settings.dayTimerDefault + delta));
  update({ settings: { ...state.settings, dayTimerDefault: next } });
}

function adjustNightTimer(delta) {
  const next = Math.max(NIGHT_TIMER_MIN, Math.min(NIGHT_TIMER_MAX, state.settings.nightTimerDefault + delta));
  update({ settings: { ...state.settings, nightTimerDefault: next } });
}

function setRule(key, value) {
  update({ rules: { ...state.rules, [key]: value } });
}

function setSetting(key, value) {
  update({ settings: { ...state.settings, [key]: value } });
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

/**
 * 开始游戏：始终可点击，未分配座位进入局内后为未知身份。SPEC §4.1 Step4 / §4.2
 * 同时把本局姓名并入姓名池并记录为上次名单（SPEC §11.2）。
 */
function startGame() {
  commitNamesToPool();
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
  resetGameUiState();
  update({ screen: 'game', log: [...state.log, entry] });
  requestWakeLock();
}

// ══════════════════════════════════════════════════════════════════
// 局内玩家网格 —— 交互（展开面板 / 修改身份 / 设为情侣）SPEC §8.3 / §8.4
// ══════════════════════════════════════════════════════════════════

/** 进局时重置玩家网格的纯 UI 展开状态。 */
function resetGameUiState() {
  gameExpandedSeat = null;
  gameDeathPickerSeat = null;
  gameRoleEditSeat = null;
  loverPairMode = false;
  loverPairFirstSeat = null;
}

/** 点击存活/阵亡折叠卡片：情侣配对模式下路由至配对逻辑，否则切换信息面板展开。SPEC §8.3 */
function handleCardTap(seat) {
  if (loverPairMode) {
    handleLoverSeatClick(seat);
    return;
  }
  gameDeathPickerSeat = null;
  gameRoleEditSeat = null;
  gameExpandedSeat = gameExpandedSeat === seat ? null : seat;
  render();
}

function cancelDeathPicker() {
  gameDeathPickerSeat = null;
  render();
}

/** 展开面板内的「修改身份」：切换为角色选择面板。SPEC §8.4 */
function openRoleEditGame(seat) {
  gameRoleEditSeat = seat;
  render();
}

function cancelRoleEditGame() {
  gameRoleEditSeat = null;
  render();
}

function assignRoleGame(roleId) {
  if (gameRoleEditSeat == null) return;
  const seat = gameRoleEditSeat;
  const players = state.players.map(p =>
    p.seat === seat ? { ...p, roleId, effectiveRoleId: roleId } : p);
  gameRoleEditSeat = null;
  update({ players });
}

function clearRoleGame(seat) {
  const players = state.players.map(p =>
    p.seat === seat ? { ...p, roleId: null, effectiveRoleId: null } : p);
  gameRoleEditSeat = null;
  update({ players });
}

/** 展开面板内的「设为情侣」：进入配对模式，本座位为已选的第一人。SPEC §5.3 */
function startLoverPairFromGame(seat) {
  loverPairMode = true;
  loverPairFirstSeat = seat;
  gameExpandedSeat = null;
  render();
}

// ══════════════════════════════════════════════════════════════════
// 流程 —— 夜晚（#11–#13 范围，暂未实现）
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
// 死亡与复活
// ══════════════════════════════════════════════════════════════════

/**
 * 标记阵亡；情侣殉情 / 魅惑连锁回流 cascadeDeaths（SPEC §5.1 步骤 7–8）。
 * 触发队列（猎人开枪等）的呈现见 #11–#13，此处不入队。
 * 先执行 + 撤销条。SPEC §5.4 / §8.2 / §8.3
 */
function markDead(seat, reason) {
  const { deaths } = cascadeDeaths(state, [{ seat, reason }]);
  const reasonBySeat = new Map(deaths.map(d => [d.seat, d.reason]));
  const players = state.players.map(p =>
    reasonBySeat.has(p.seat)
      ? { ...p, alive: false, deathReason: reasonBySeat.get(p.seat), deathDay: state.day, deathPhase: state.phase }
      : p);

  const now = Date.now();
  const entries = deaths.map(d => ({
    day: state.day, phase: state.phase, type: 'death',
    actor: null, targets: [d.seat], text: `${d.seat}号 ${d.reason}`, result: null, ts: now,
  }));

  gameDeathPickerSeat = null;
  gameExpandedSeat = null;
  update({ players, log: [...state.log, ...entries] });

  const label = deaths.length > 1
    ? `已标记 ${deaths.map(d => `${d.seat}号`).join('、')} 阵亡`
    : `已标记 ${seat}号 阵亡（${reason}）`;
  showUndoBar(label);
}

/** 复活。经点击展开卡片后的按钮触发，不与长按共用手势。先执行 + 撤销条。SPEC §8.2 / §8.3 */
function revive(seat) {
  const players = state.players.map(p =>
    p.seat === seat ? { ...p, alive: true, deathReason: null, deathDay: null, deathPhase: null } : p);
  const entry = {
    day: state.day, phase: state.phase, type: 'death',
    actor: null, targets: [seat], text: `${seat}号 恢复存活`, result: null, ts: Date.now(),
  };
  gameExpandedSeat = null;
  update({ players, log: [...state.log, entry] });
  showUndoBar(`已恢复 ${seat}号 存活`);
}

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

/**
 * 长按 550ms 标记阵亡 → 内联死因芯片。SPEC §8.3
 * 与「点击展开信息面板」手势彻底分离：长按触发后拦截随之而来的 click，
 * 避免松开时误触发展开。
 */
function bindDeathLongPress(el, seat) {
  if (!el) return;
  let timer = null;
  let longPressed = false;

  const clear = () => {
    if (timer) { clearTimeout(timer); timer = null; }
  };

  el.addEventListener('pointerdown', (e) => {
    if (e.button != null && e.button !== 0) return;
    longPressed = false;
    timer = setTimeout(() => {
      longPressed = true;
      clear();
      gameDeathPickerSeat = seat;
      gameExpandedSeat = null;
      render();
    }, LONG_PRESS_DEATH_MS);
  });
  el.addEventListener('pointerup', clear);
  el.addEventListener('pointerleave', clear);
  el.addEventListener('pointercancel', clear);
  el.addEventListener('click', (e) => {
    if (longPressed) {
      e.preventDefault();
      e.stopPropagation();
      longPressed = false;
    }
  }, true);
}

/** 先执行 + 撤销条（~5s），驻留后自动隐藏。SPEC §8.2 */
function showUndoBar(text) {
  const bar = document.getElementById('undo-bar');
  if (!bar) return;
  if (undoBarTimer) { clearTimeout(undoBarTimer); undoBarTimer = null; }
  bar.hidden = false;
  bar.innerHTML = `
    <span class="undo-bar-text">${escapeText(text)}</span>
    <button type="button" class="btn btn-ghost btn-sm" data-action="undo-bar-undo">撤销</button>
  `;
  undoBarTimer = setTimeout(hideUndoBar, UNDO_BAR_MS);
}

/** 隐藏撤销条（自动到时，或法官点了撤销/继续操作）。 */
function hideUndoBar() {
  if (undoBarTimer) { clearTimeout(undoBarTimer); undoBarTimer = null; }
  const bar = document.getElementById('undo-bar');
  if (bar) { bar.hidden = true; bar.innerHTML = ''; }
}

/**
 * 把手拖拽排序，基于 Pointer Events（HTML5 DnD 在触摸设备不可用）。
 * 仅可从 `.drag-handle` 起拖；拖动时被拖项抬起（position: fixed + 阴影），
 * 原位置由 `.drop-gap` 占位（高度动画），靠近视口上下边缘时自动滚动。
 * 供 Step 2 姓名排序与 Step 3 夜晚顺序共用。SPEC §4.1
 * @param {HTMLElement} container 直接子元素均为 `.reorder-item`
 * @param {(from:number, to:number) => void} onReorder
 */
function bindDragReorder(container, onReorder) {
  if (!container) return;

  let dragEl = null;
  let gapEl = null;
  let fromIndex = -1;
  let startClientY = 0;
  let startTop = 0;
  let pointerId = null;
  let autoScrollRaf = null;
  let lastClientY = 0;

  function itemsExcludingDrag() {
    return Array.from(container.querySelectorAll(':scope > .reorder-item')).filter(el => el !== dragEl);
  }

  function runAutoScroll() {
    const margin = 56;
    const vh = window.innerHeight;
    let delta = 0;
    if (lastClientY < margin) delta = -(margin - lastClientY) * 0.4;
    else if (lastClientY > vh - margin) delta = (lastClientY - (vh - margin)) * 0.4;
    if (delta !== 0) window.scrollBy(0, delta);
    autoScrollRaf = requestAnimationFrame(runAutoScroll);
  }

  function updateGapPosition(clientY) {
    const siblings = itemsExcludingDrag();
    let target = null;
    for (const sib of siblings) {
      const r = sib.getBoundingClientRect();
      if (clientY < r.top + r.height / 2) { target = sib; break; }
    }
    if (target) {
      if (target.previousElementSibling !== gapEl) container.insertBefore(gapEl, target);
    } else if (container.lastElementChild !== gapEl) {
      container.appendChild(gapEl);
    }
  }

  function onPointerMove(e) {
    if (!dragEl) return;
    lastClientY = e.clientY;
    const dy = e.clientY - startClientY;
    dragEl.style.top = `${startTop + dy}px`;
    updateGapPosition(e.clientY);
  }

  function cleanup() {
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerUp);
    if (autoScrollRaf) { cancelAnimationFrame(autoScrollRaf); autoScrollRaf = null; }
    if (dragEl) {
      dragEl.classList.remove('dragging');
      dragEl.style.position = '';
      dragEl.style.left = '';
      dragEl.style.top = '';
      dragEl.style.width = '';
      dragEl.style.zIndex = '';
    }
    if (gapEl) gapEl.remove();
  }

  function onPointerUp() {
    if (!dragEl) return;
    const remaining = Array.from(container.children).filter(el => el !== dragEl);
    const to = remaining.indexOf(gapEl);
    const from = fromIndex;
    cleanup();
    dragEl = null; gapEl = null; fromIndex = -1;
    if (to >= 0 && to !== from) onReorder(from, to);
  }

  container.addEventListener('pointerdown', (e) => {
    const handle = e.target.closest('.drag-handle');
    if (!handle || !container.contains(handle)) return;
    const item = handle.closest('.reorder-item');
    if (!item || item.parentElement !== container) return;

    e.preventDefault();
    pointerId = e.pointerId;
    dragEl = item;
    fromIndex = Array.from(container.querySelectorAll(':scope > .reorder-item')).indexOf(item);

    const rect = item.getBoundingClientRect();
    startClientY = e.clientY;
    lastClientY = e.clientY;
    startTop = rect.top;

    gapEl = document.createElement('div');
    gapEl.className = 'drop-gap is-active';
    gapEl.style.height = `${rect.height}px`;

    item.classList.add('dragging');
    item.style.position = 'fixed';
    item.style.left = `${rect.left}px`;
    item.style.top = `${rect.top}px`;
    item.style.width = `${rect.width}px`;
    item.style.zIndex = '10';

    item.after(gapEl);

    try { handle.setPointerCapture(pointerId); } catch { /* 部分环境不支持，忽略 */ }
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
    autoScrollRaf = requestAnimationFrame(runAutoScroll);
  });
}

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
    case 'apply-last-roster':   applyLastRoster(); break;
    case 'fill-name':           fillNameFromChip(el.dataset.seat, el.dataset.name); break;
    case 'reset-night-order':   resetNightOrder(); break;
    case 'day-timer-dec':       adjustDayTimer(-DAY_TIMER_STEP); break;
    case 'day-timer-inc':       adjustDayTimer(DAY_TIMER_STEP); break;
    case 'night-timer-dec':     adjustNightTimer(-NIGHT_TIMER_STEP); break;
    case 'night-timer-inc':     adjustNightTimer(NIGHT_TIMER_STEP); break;
    case 'toggle-rule':         setRule(el.dataset.rule, el.checked); break;
    case 'set-witch-self-save': setRule('witchSelfSave', el.dataset.value); break;
    case 'toggle-setting':      setSetting(el.dataset.setting, el.checked); break;
    case 'select-seat4':      selectSeat4(Number(el.dataset.seat)); break;
    case 'assign-role4':      assignRole4(el.dataset.role); break;
    case 'clear-role4':       clearRole4(Number(el.dataset.seat)); break;
    case 'assign-random-roles': randomAssignRemainingRoles(); break;
    case 'toggle-lover-mode': toggleLoverMode(); break;
    case 'start-game':        startGame(); break;
    case 'toggle-alive-expand': handleCardTap(Number(el.dataset.seat)); break;
    case 'cancel-death-picker': cancelDeathPicker(); break;
    case 'mark-dead':          markDead(Number(el.dataset.seat), el.dataset.reason); break;
    case 'revive-game':        revive(Number(el.dataset.seat)); break;
    case 'edit-role-game':     openRoleEditGame(Number(el.dataset.seat)); break;
    case 'cancel-role-edit-game': cancelRoleEditGame(); break;
    case 'assign-role-game':   assignRoleGame(el.dataset.role); break;
    case 'clear-role-game':    clearRoleGame(Number(el.dataset.seat)); break;
    case 'set-lover-game':     startLoverPairFromGame(Number(el.dataset.seat)); break;
    case 'unpair-lover-game':  unpairLovers(Number(el.dataset.seat)); break;
    case 'undo-bar-undo':      hideUndoBar(); undo(); break;
    default: break;
  }
}

/** 姓名输入框逐字符更新：直接写状态，不触发整屏重渲染（保留焦点/光标）。 */
function handleAppInput(e) {
  const el = e.target.closest?.('[data-action="edit-name"]');
  if (!el) return;
  setPlayerNameSilently(Number(el.dataset.seat), el.value);
}

/** 姓名输入框聚焦时展开姓名池芯片（同一时刻仅展开一个）。SPEC §4.1 */
function handleNameFocusIn(e) {
  const input = e.target.closest?.('[data-action="edit-name"]');
  if (!input) return;
  document.querySelectorAll('.name-pool-chips').forEach(el => el.setAttribute('hidden', ''));
  input.closest('.name-row')?.querySelector('.name-pool-chips')?.removeAttribute('hidden');
}

/** 失焦收起芯片面板；延迟以放行芯片点击（否则点击前先失焦会导致面板消失）。 */
function handleNameFocusOut(e) {
  const input = e.target.closest?.('[data-action="edit-name"]');
  if (!input) return;
  const row = input.closest('.name-row');
  setTimeout(() => {
    if (row && !row.contains(document.activeElement)) {
      row.querySelector('.name-pool-chips')?.setAttribute('hidden', '');
    }
  }, 150);
}

/** 转义 HTML 属性值（姓名可能含 `"` `&` `<`）。 */
function escapeAttr(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/** 转义 HTML 文本内容。 */
function escapeText(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;');
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

/** 对局进行中申请屏幕常亮，结束时释放。不支持的环境（无 API / 被拒绝）静默失败。SPEC §12.3 */
async function requestWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    wakeLockSentinel = await navigator.wakeLock.request('screen');
    wakeLockSentinel.addEventListener?.('release', () => { wakeLockSentinel = null; });
  } catch {
    wakeLockSentinel = null;
  }
}

function releaseWakeLock() {
  const sentinel = wakeLockSentinel;
  wakeLockSentinel = null;
  sentinel?.release?.().catch(() => {});
}

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

  namePool = loadNames();

  applyTheme(state.settings.theme);
  const app = document.getElementById('app');
  app.addEventListener('click', handleAppClick);
  app.addEventListener('input', handleAppInput);
  app.addEventListener('focusin', handleNameFocusIn);
  app.addEventListener('focusout', handleNameFocusOut);
  // Wake Lock 在标签页切走时被系统自动释放，切回时若仍在局内需重新申请。SPEC §12.3
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.screen === 'game') requestWakeLock();
  });
  render();
}

boot();
