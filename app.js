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
 * 分配身份与开局 #9）、局内玩家网格与死亡标记（#10）、夜晚流程引导 / 技能
 * 追踪 / 信息展示（#11）、天亮结算 / 死亡触发队列 / 警报通道（#12）、
 * 白天流程与主动行为：放逐、骑士决斗、白狼王自爆带人、普通狼人自爆、
 * 情侣手动配对、进入下一夜（#13）与主题应用、计时器（自由 / 发言两种模式）
 * 与每日随机首发言（#14）、局内日志页（#15）、阵营计数条 / 战报页 / 日志导出
 * （#16）已实现。PWA 相关（Service Worker 注册）留给 #17，此处仅提供
 * 可路由到达的最小占位实现。
 */

import {
  ROLES, ROLE_MAP, WOLF_ROLE_IDS, STEP_META, DEFAULT_NIGHT_ORDER,
  DEATH_REASONS, PRESETS, DEFAULT_RULES, DEFAULT_SETTINGS,
  ABNORMAL_DEATH_REASONS, CAMP, CAMP_NAME,
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
  charm: '魅惑', revealed: '翻牌', active: '技能',
};

/** 夜晚步骤日志文本的动词（SPEC §9 / §16.1 —— 例：「预言家查验 5号 → 狼人」） */
const STEP_LOG_VERB = {
  wolfkill: '击杀', guard: '守护', charm: '魅惑', mechwolf: '复制',
  cupid: '连接', magician: '交换', seer: '查验', psychic: '查验',
  fox: '查验', gravekeeper: '查验', bear: '判定',
};

/** 引擎警告类型中接入警报通道的子集（SPEC §10.3）。女巫同夜双药不在通道范围内。 */
const ALERT_WARNING_TYPES = new Set(['doubleProtect', 'guardRepeat', 'witchSelfSave']);

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

// ── 白天主动行为 —— 骑士决斗 / 白狼王自爆带人 / 狼人自爆，纯 UI 瞬态，不入 GameState/撤销栈。SPEC §4.3 / §5.4 ──
let dayActionMode = null;          // null | 'duelTarget' | 'duelConfirm' | 'wwkTarget' | 'wolfSelfDestructPick'
let dayActionSeat = null;          // 发起行为的座位（骑士 / 白狼王）
let dayActionTarget = null;        // 已选中的对手 / 目标座位

// ── 局内玩家网格 —— 纯 UI 展开状态，不入 GameState/撤销栈。SPEC §12 / §8.3 ──
let gameExpandedSeat = null;       // 当前展开信息面板的座位（存活或阵亡）
let gameDeathPickerSeat = null;    // 当前展示死因芯片的座位（长按触发）
let gameRoleEditSeat = null;       // 当前正在「修改身份」的座位

// ── 夜晚步骤 —— 当前步骤尚未确认的目标选择，纯 UI 瞬态，不入 GameState/撤销栈。
//    确认（完成）时才写入 nightActions。SPEC §4.2 / §9 ──
let nightStepTargets = [];         // 当前步骤已点选的目标座位（非女巫步骤）
let witchChoice = null;            // 'save' | 'poison' | 'skip' | null —— 女巫本步骤已选择的行动
let witchPoisonTarget = null;      // 女巫「使用毒药」已点选的目标座位

// ── 日志页 —— 筛选与分组展开，纯 UI 瞬态，不入 GameState/撤销栈。SPEC §16.2 ──
let logFilter = 'all';             // 'all' | 'death' | 'skill' | 'note'
let logGroupOpen = {};             // 分组 key（`${day}-${phase}`）-> 是否展开，未记录时默认「当前阶段展开」

let undoBarTimer = null;           // 撤销条自动隐藏定时器
let wakeLockSentinel = null;       // Screen Wake Lock 句柄

/** 计时器显示刷新节拍。仅用于按 endsAt 推算剩余时间并重绘，绝不用于递减状态。SPEC §14.1 */
let timerTickHandle = null;

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
    nightSteps: [],              // 本夜活跃步骤序列快照，夜晚开始时冻结，避免技能耗尽导致的重算错位
    daySubPhase: null,          // 'deathReview' | 'triggers' | 'main'，白天子阶段（SPEC §4.3 / §5.4）
    nightActions: {},
    lastGuardTarget: null,
    pendingDeaths: [],
    triggerQueue: [],
    pendingNightAdvance: false,  // 狼人自爆等「白天立即结束」行为：触发队列处理完毕后自动进入下一夜
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
    alertQueue: [],              // 待呈现的警报队列，一次一条（SPEC §10.2 —— 常驻至法官点击「知道了」）
    startedAt: null,             // 游戏开始时间戳，用于战报页计算总时长（SPEC §4.4）
    winner: null,                // 'good' | 'wolf' | 'draw' | null，战报页由法官点选（SPEC §17）
  };
}

/** 依角色技能槽建立初始 skills 对象：每个技能键为 true（未使用/可用）。roleId 为空则返回 {}。 */
function initSkills(roleId) {
  const skills = {};
  const role = roleId ? ROLE_MAP[roleId] : null;
  for (const key of role?.skills ?? []) skills[key] = true;
  return skills;
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
 * 未解决的续接横幅仍在等待法官选择时，不覆盖 localStorage 中的旧存档（SPEC §11.1）。
 * 一旦法官续接/放弃（清空 pendingResume），恢复正常持久化。
 */
function persistState() {
  if (pendingResume) return;
  saveGame(state);
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

  persistState();
  render();
}

/** 撤销至上一快照。SPEC §8.5 */
function undo() {
  if (!state.history.length) return;
  const restored = normalizeLoadedState(state.history[state.history.length - 1]);
  const remaining = state.history.slice(0, -1);
  state = { ...restored, history: remaining };
  persistState();
  render();
}

/**
 * 补齐历史存档中可能缺失的字段默认值，避免读取旧结构存档（或撤销回旧快照）时
 * 因字段缺失而崩溃。不匹配 STATE_VERSION 的存档已由 storage.js 整体丢弃，
 * 这里处理的是同版本内新增字段的向后兼容。
 */
function normalizeLoadedState(saved) {
  if (!saved) return saved;
  return {
    ...saved,
    alertQueue: saved.alertQueue ?? [],
    daySubPhase: saved.daySubPhase ?? null,
    pendingDeaths: saved.pendingDeaths ?? [],
    nightSteps: saved.nightSteps ?? [],
    triggerQueue: saved.triggerQueue ?? [],
    pendingNightAdvance: saved.pendingNightAdvance ?? false,
    startedAt: saved.startedAt ?? null,
    winner: saved.winner ?? null,
  };
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
  renderAlertBanner();
  renderPhasePanel();
  renderPlayerGrid();
}

/** 常驻警告横幅：不自动消失，需法官点击「知道了」确认。SPEC §10.2 */
function renderAlertBanner() {
  const host = document.getElementById('alert-banner');
  if (!host) return;
  const current = state.alertQueue[0];
  if (!current) {
    host.hidden = true;
    host.innerHTML = '';
    return;
  }
  host.hidden = false;
  host.innerHTML = `
    <div class="banner-inline" role="alert">
      <span>⚠ ${escapeText(current.text)}</span>
      <div class="banner-actions">
        <button type="button" class="btn btn-secondary btn-sm" data-action="dismiss-alert">知道了</button>
      </div>
    </div>
  `;
}

/** 固定控制区：阶段标题 + 阵营计数条 + 计时器 + 撤销 / 日志 / 长按结束。SPEC §12.1 / §14 / §17 */
function renderGameHeader() {
  const header = document.getElementById('game-header');
  if (!header) return;
  const counts = campCounts(state);
  header.innerHTML = `
    <div class="game-header-row">
      <div class="game-header-title-group">
        <h1 class="game-header-title">第${state.day}${state.phase === 'night' ? '晚' : '天'}</h1>
        <span class="camp-count"${counts.unknown > 0 ? ' data-has-unknown="true"' : ''} aria-label="阵营计数，仅统计身份已知且存活的玩家">${campCountLabel(counts)}</span>
      </div>
      <div class="actions">
        <button type="button" class="btn btn-icon" data-action="undo" aria-label="撤销">↶</button>
        <button type="button" class="btn btn-secondary" data-action="goto-log">日志</button>
        <button type="button" class="btn btn-secondary btn-longpress" data-action="end-game" data-longpress="true">
          <span>长按结束</span>
        </button>
      </div>
    </div>
    ${renderTimerRowHtml()}
  `;
  bindLongPressGuard(header.querySelector('[data-action="end-game"]'), () => {
    releaseWakeLock();
    hideUndoBar();
    update({ screen: 'report' }, { snapshot: false });
  });
}

/** 阵营计数条文案，形如「狼3·神2·民4」；存在未知身份座位时附加提示。SPEC §17 */
function campCountLabel(counts) {
  const base = `狼${counts.wolf}·神${counts.god}·民${counts.civ}`;
  return counts.unknown > 0 ? `${base} · 未知${counts.unknown}（不可尽信）` : base;
}

/**
 * 计时器控制行：模式切换（自由 / 发言）+ 剩余时间显示 + 播放暂停 + ±10s。
 * 自由模式附快捷档位芯片；发言模式附当前发言者与上一位 / 下一位。SPEC §14
 */
function renderTimerRowHtml() {
  const t = state.timer;
  const running = t.running;
  const paused = !running && t.pausedRemaining != null;
  const toggleLabel = running ? '暂停' : '开始';
  const toggleGlyph = running ? '⏸' : '▶';
  const toggleDisabled = !running && !paused && t.mode === 'speech' && t.speechSeat == null;

  const modeTabsHtml = `
    <div class="timer-mode-tabs" role="group" aria-label="计时模式">
      <button type="button" class="btn btn-ghost btn-sm${t.mode === 'free' ? ' is-active' : ''}" data-action="set-timer-mode" data-mode="free">自由</button>
      <button type="button" class="btn btn-ghost btn-sm${t.mode === 'speech' ? ' is-active' : ''}" data-action="set-timer-mode" data-mode="speech">发言</button>
    </div>
  `;

  const subRowHtml = t.mode === 'free' ? `
    <div class="timer-presets">
      ${[30, 60, 90, 120, 180].map(s => `<button type="button" class="chip" data-action="timer-preset" data-seconds="${s}">${s}s</button>`).join('')}
    </div>
  ` : `
    <div class="speech-controls">
      <span class="speech-current">${t.speechSeat != null ? `${t.speechSeat}号发言中 · ${t.speechDirection === 1 ? '顺时针' : '逆时针'}` : '尚未选定发言起点'}</span>
      <button type="button" class="btn btn-secondary btn-sm" data-action="speech-prev" ${t.speechSeat == null ? 'disabled' : ''}>‹ 上一位</button>
      <button type="button" class="btn btn-secondary btn-sm" data-action="speech-next" ${t.speechSeat == null ? 'disabled' : ''}>下一位 ›</button>
    </div>
  `;

  return `
    <div class="timer-row">
      ${modeTabsHtml}
      <span id="timer-remaining" class="timer-remaining">${formatTimerMs(timerRemainingMs())}</span>
      <div class="timer-controls">
        <button type="button" class="btn btn-icon" data-action="timer-toggle" aria-label="${toggleLabel}计时"${toggleDisabled ? ' disabled' : ''}>${toggleGlyph}</button>
        <button type="button" class="btn btn-icon" data-action="timer-adjust" data-delta="-10" aria-label="减少10秒">−10s</button>
        <button type="button" class="btn btn-icon" data-action="timer-adjust" data-delta="10" aria-label="增加10秒">+10s</button>
      </div>
      ${subRowHtml}
    </div>
  `;
}

/** mm:ss 格式化，向上取整避免刚启动时因毫秒误差显示少 1 秒。 */
function formatTimerMs(ms) {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** 固定步骤区。夜晚流程见本节；白天流程见 #12–#13。SPEC §12.1 */
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

  if (state.phase === 'day') {
    if (dayActionMode) {
      panel.innerHTML = renderDayActionBanner();
      return;
    }
    if (state.daySubPhase === 'deathReview') {
      panel.innerHTML = renderDeathReviewPanel();
      return;
    }
    if (state.daySubPhase === 'triggers') {
      panel.innerHTML = renderTriggerPanel();
      return;
    }
    panel.innerHTML = renderDayMainPanel();
    return;
  }

  const steps = state.nightSteps;
  if (state.stepIndex >= steps.length) {
    panel.innerHTML = `
      <div class="phase-step phase-step-dawn">
        <p class="note">夜晚步骤已全部完成</p>
        <button type="button" class="btn btn-primary btn-block" data-action="end-night">天亮了</button>
      </div>
    `;
    return;
  }

  panel.innerHTML = renderNightStepHtml(steps[state.stepIndex]);
}

/** 天亮结算 —— 死亡提案列表，法官可增删后确认。SPEC §4.3 / §5.1 */
function renderDeathReviewPanel() {
  const deaths = state.pendingDeaths;
  const rows = deaths.length
    ? deaths.map(d => `
        <div class="death-proposal-row">
          <span class="tag tag-accent">${d.seat}号</span>
          <span class="death-proposal-explanation">${escapeText(d.explanation)}</span>
          <button type="button" class="btn btn-ghost btn-sm" data-action="remove-pending-death" data-seat="${d.seat}" aria-label="移除${d.seat}号死亡提案">✕</button>
        </div>
      `).join('')
    : '<p class="note">本回合无死亡</p>';

  return `
    <div class="phase-step phase-step-dawn">
      <div class="phase-step-header">
        <h2 class="phase-step-title">天亮结算</h2>
        <p class="phase-step-instruction">核对死亡名单；点选下方存活玩家可添加，✕ 可移除</p>
      </div>
      <div class="death-proposal-list">${rows}</div>
      <div class="phase-step-actions">
        <button type="button" class="btn btn-primary btn-block" data-action="confirm-pending-deaths">确认死亡</button>
      </div>
    </div>
  `;
}

/** 死亡触发队列 —— 一次一条呈现。SPEC §5.4 */
function renderTriggerPanel() {
  const current = state.triggerQueue[0];
  if (!current) return '';

  if (current.type === 'shot') {
    return `
      <div class="phase-step">
        <div class="phase-step-header">
          <h2 class="phase-step-title">${escapeText(current.label)}</h2>
          <p class="phase-step-instruction">点选下方玩家网格中的目标，或跳过</p>
        </div>
        <div class="phase-step-actions">
          <button type="button" class="btn btn-secondary btn-block" data-action="skip-trigger">跳过</button>
        </div>
      </div>
    `;
  }

  if (current.type === 'idiotReveal') {
    return `
      <div class="phase-step">
        <div class="phase-step-header">
          <h2 class="phase-step-title">${escapeText(current.label)}</h2>
          <p class="phase-step-instruction">翻牌后不死亡，但失去投票权</p>
        </div>
        <div class="phase-step-actions">
          <button type="button" class="btn btn-primary" data-action="resolve-idiot-reveal">翻牌免死</button>
          <button type="button" class="btn btn-secondary" data-action="skip-trigger">跳过</button>
        </div>
      </div>
    `;
  }

  return '';
}

/**
 * 白天主动行为入口 + 「进入下一夜」。SPEC §4.3 步骤 5 / §5.4
 * 骑士决斗 / 白狼王自爆带人 / 狼人自爆按钮仅在存在合资格存活行动者时显示。
 */
function renderDayMainPanel() {
  const knight = eligibleDayActionPlayers('duel')[0];
  const whiteWolfKing = eligibleDayActionPlayers('selfDestructWithTarget')[0];
  const selfDestructWolves = eligibleDayActionPlayers('selfDestruct');

  const actionButtons = [
    knight ? `<button type="button" class="btn btn-secondary btn-block" data-action="start-duel">骑士决斗</button>` : '',
    whiteWolfKing ? `<button type="button" class="btn btn-secondary btn-block" data-action="start-wwk">白狼王自爆带人</button>` : '',
    selfDestructWolves.length ? `<button type="button" class="btn btn-secondary btn-block" data-action="start-wolf-selfdestruct">狼人自爆</button>` : '',
  ].filter(Boolean).join('');

  return `
    <div class="phase-step">
      ${renderFirstSpeakerBannerHtml()}
      <div class="phase-step-header">
        <h2 class="phase-step-title">白天</h2>
        <p class="phase-step-instruction">死亡与触发已处理。长按玩家卡片可标记放逐；随时可发起白天主动行为</p>
      </div>
      <div class="day-action-list">${actionButtons}</div>
      <div class="phase-step-actions">
        <button type="button" class="btn btn-primary btn-block" data-action="end-day">进入下一夜</button>
      </div>
    </div>
  `;
}

/**
 * 每日随机首发言抽取结果的内联横幅：已抽取但尚未点击「开始发言」时显示。
 * 一旦发言计时启动（running 或 paused）即视为已采用，横幅让位于发言控制区。SPEC §15
 */
function renderFirstSpeakerBannerHtml() {
  const t = state.timer;
  if (t.mode !== 'speech' || t.speechSeat == null) return '';
  if (t.running || t.pausedRemaining != null) return '';
  const dirLabel = t.speechDirection === 1 ? '顺时针' : '逆时针';
  return `
    <div class="banner-inline" role="status">
      <span>本轮发言：${t.speechSeat}号 开始 · ${dirLabel}</span>
      <div class="banner-actions">
        <button type="button" class="btn btn-secondary btn-sm" data-action="redraw-first-speaker">重新抽取</button>
        <button type="button" class="btn btn-primary btn-sm" data-action="start-speech-timer">开始发言</button>
      </div>
    </div>
  `;
}

/** 存活且具备指定 dayAction 资格（含一次性技能未耗尽）的玩家。SPEC §5.4 / §6 */
function eligibleDayActionPlayers(dayAction) {
  return state.players.filter(p => {
    if (!p.alive) return false;
    const role = ROLE_MAP[p.effectiveRoleId ?? p.roleId];
    if (!role || role.dayAction !== dayAction) return false;
    if (dayAction === 'duel' && p.skills?.duel === false) return false;
    if (dayAction === 'selfDestructWithTarget' && p.skills?.selfDestruct === false) return false;
    return true;
  });
}

/** 白天主动行为进行中的内联横幅：骑士决斗 / 白狼王自爆带人 / 狼人自爆的分步引导。SPEC §4.3 */
function renderDayActionBanner() {
  if (dayActionMode === 'duelTarget') {
    return `
      <div class="banner-inline" role="status">
        <span>骑士 ${dayActionSeat}号 决斗 · 点选下方玩家网格中的对手</span>
        <div class="banner-actions">
          <button type="button" class="btn btn-ghost btn-sm" data-action="cancel-day-action">取消</button>
        </div>
      </div>
    `;
  }

  if (dayActionMode === 'duelConfirm') {
    return `
      <div class="banner-inline" role="status">
        <span>骑士 ${dayActionSeat}号 与 ${dayActionTarget}号 决斗 · 法官裁定胜负</span>
        <div class="banner-actions">
          <button type="button" class="btn btn-secondary btn-sm" data-action="resolve-duel" data-result="knightWins">骑士获胜</button>
          <button type="button" class="btn btn-secondary btn-sm" data-action="resolve-duel" data-result="knightLoses">骑士落败</button>
          <button type="button" class="btn btn-ghost btn-sm" data-action="cancel-day-action">取消</button>
        </div>
      </div>
    `;
  }

  if (dayActionMode === 'wwkTarget') {
    return `
      <div class="banner-inline" role="status">
        <span>白狼王 ${dayActionSeat}号 自爆带人 · 点选下方玩家网格中要带走的目标</span>
        <div class="banner-actions">
          <button type="button" class="btn btn-ghost btn-sm" data-action="cancel-day-action">取消</button>
        </div>
      </div>
    `;
  }

  if (dayActionMode === 'wolfSelfDestructPick') {
    return `
      <div class="banner-inline" role="status">
        <span>点选下方玩家网格中要自爆的狼人</span>
        <div class="banner-actions">
          <button type="button" class="btn btn-ghost btn-sm" data-action="cancel-day-action">取消</button>
        </div>
      </div>
    `;
  }

  return '';
}

/** 当前活跃夜晚步骤所对应的角色（座位已知的行动者）。 */
function stepActorSeat(stepId) {
  const p = state.players.find(p =>
    p.alive && ROLE_MAP[p.effectiveRoleId ?? p.roleId]?.nightStep === stepId);
  return p ? p.seat : null;
}

/** 当前步骤对应的角色声明（用于 §8.4 隐式补全；wolfkill 存在多个候选角色时取第一个，即普通狼人）。 */
function roleForNightStep(stepId) {
  return ROLES.find(r => r.nightStep === stepId) ?? null;
}

/** 单个夜晚步骤面板：角色名 + 口播提示 + 目标选择/信息答案 + 完成·跳过。SPEC §4.2 / §9 */
function renderNightStepHtml(stepId) {
  const meta = STEP_META[stepId];
  const { body, confirmDisabled } = renderNightStepBody(stepId, meta);

  return `
    <div class="phase-step">
      <div class="phase-step-header">
        <h2 class="phase-step-title">${escapeText(meta.name)}</h2>
        <p class="phase-step-instruction">${escapeText(meta.instruction)}</p>
      </div>
      ${body}
      <div class="phase-step-actions">
        <button type="button" class="btn btn-secondary" data-action="skip-night-step">跳过</button>
        <button type="button" class="btn btn-primary" data-action="confirm-night-step"${confirmDisabled ? ' disabled' : ''}>完成</button>
      </div>
    </div>
  `;
}

/** 未知身份的降级提示。SPEC §8.4 / §9 */
const UNKNOWN_INFO_NOTE = '<p class="note">未知身份 — 请手动判断</p>';

function renderNightStepBody(stepId, meta) {
  if (stepId === 'witch') return renderWitchStepBody();

  if (meta.targets === 0) {
    const info = computeStepInfo(state, stepId, []);
    if (!info.known) return { body: UNKNOWN_INFO_NOTE, confirmDisabled: false };
    const seatTag = info.seat != null ? `<span class="tag">${info.seat}号</span>` : '';
    return {
      body: `<div class="step-info-answer">${seatTag}<span class="answer-text">${escapeText(info.result)}</span></div>`,
      confirmDisabled: false,
    };
  }

  const info = meta.info && nightStepTargets.length ? computeStepInfo(state, stepId, nightStepTargets) : null;
  const targetsLabel = nightStepTargets.length
    ? nightStepTargets.map(s => `${s}号`).join('、')
    : '';

  let body;
  if (!nightStepTargets.length) {
    body = `<p class="note">请在下方玩家网格中点选目标（0/${meta.targets}）</p>`;
  } else if (!meta.info) {
    body = `<p class="note">已选 ${targetsLabel}（${nightStepTargets.length}/${meta.targets}）</p>`;
  } else if (info.known) {
    const chainTag = info.chain ? info.chain.map(s => `${s}号`).join('·') : targetsLabel;
    body = `<div class="step-info-answer"><span class="tag">${chainTag}</span><span class="answer-text">${escapeText(info.result)}</span></div>`;
  } else {
    body = `<div class="step-info-answer"><span class="tag">${targetsLabel}</span></div>${UNKNOWN_INFO_NOTE}`;
  }

  return { body, confirmDisabled: nightStepTargets.length < meta.targets };
}

/** 女巫步骤：先显示今晚死亡目标，再呈现解药 / 毒药 / 不使用。SPEC §9 */
function renderWitchStepBody() {
  const actorSeat = stepActorSeat('witch');
  const actor = state.players.find(p => p.seat === actorSeat);
  const nightDeathSeat = state.nightActions.wolfTarget ?? null;
  const hasAntidote = !actor || actor.skills?.antidote !== false;
  const hasPoison = !actor || actor.skills?.poison !== false;

  const deathLine = nightDeathSeat != null
    ? `<p class="step-death-line">今晚死亡：${nightDeathSeat}号</p>`
    : `<p class="step-death-line">今晚无夜间死亡信息</p>`;

  const buttons = `
    <div class="witch-actions">
      ${hasAntidote && nightDeathSeat != null ? `<button type="button" class="btn btn-secondary${witchChoice === 'save' ? ' is-active' : ''}" data-action="witch-choice" data-choice="save">使用解药</button>` : ''}
      ${hasPoison ? `<button type="button" class="btn btn-secondary${witchChoice === 'poison' ? ' is-active' : ''}" data-action="witch-choice" data-choice="poison">使用毒药</button>` : ''}
      <button type="button" class="btn btn-secondary${witchChoice === 'skip' ? ' is-active' : ''}" data-action="witch-choice" data-choice="skip">不使用</button>
    </div>
  `;

  let selectionLine = '';
  if (witchChoice === 'save') {
    selectionLine = `<p class="note">将对 ${nightDeathSeat}号 使用解药</p>`;
  } else if (witchChoice === 'poison') {
    selectionLine = witchPoisonTarget != null
      ? `<p class="note">将对 ${witchPoisonTarget}号 使用毒药</p>`
      : `<p class="note">请在下方玩家网格中点选毒药目标</p>`;
  }

  const confirmDisabled = witchChoice == null || (witchChoice === 'poison' && witchPoisonTarget == null);
  return { body: deathLine + buttons + selectionLine, confirmDisabled };
}

/** 日志筛选芯片。SPEC §16.2 */
const LOG_FILTERS = [
  { key: 'all',   label: '全部' },
  { key: 'death', label: '死亡' },
  { key: 'skill', label: '技能' },
  { key: 'note',  label: '备注' },
];

/** 日志条目类型显示名。SPEC §3.4 / §16.1 */
const LOG_TYPE_LABEL = { skill: '技能', death: '死亡', system: '系统', note: '备注', warning: '警告' };

/**
 * 日志页：分组折叠浏览 + 筛选 + 法官备注。整页替换式屏幕，非覆盖层。SPEC §16
 * 类型化事件的写入见 addLog / markDead / revive / buildStepLogEntry 等。
 */
function renderLog() {
  const host = document.getElementById('screen-log');
  if (!host) return;

  const currentKey = `${state.day}-${state.phase}`;
  const groups = buildLogGroups(logFilter);

  const filterHtml = LOG_FILTERS.map(f => `
    <button type="button" class="chip${logFilter === f.key ? ' is-active' : ''}" data-action="set-log-filter" data-filter="${f.key}">${f.label}</button>
  `).join('');

  const groupsHtml = groups.length
    ? groups.map(g => renderLogGroup(g, currentKey)).join('')
    : `<p class="note">暂无符合条件的日志</p>`;

  host.innerHTML = `
    <div class="wrap log-screen">
      <div class="setup-header">
        <h1>日志</h1>
        <button type="button" class="btn btn-secondary" data-action="goto-game">‹ 返回</button>
      </div>
      <div class="log-filter-row" role="group" aria-label="日志筛选">${filterHtml}</div>
      <div class="log-groups">${groupsHtml}</div>
      <div class="log-note-row">
        <input type="text" id="log-note-input" class="input" placeholder="添加法官备注…" maxlength="200" aria-label="法官备注">
        <button type="button" class="btn btn-secondary" data-action="add-note">记录</button>
      </div>
    </div>
  `;
}

/**
 * 按 `第N夜` / `第N天` 分组；组内保持写入顺序（时间正序），组间按最近写入倒序
 * （当前阶段位于顶部）。空组（被筛选清空）不展示。SPEC §16.2
 */
function buildLogGroups(filter) {
  const order = [];
  const byKey = new Map();
  state.log.forEach((entry, idx) => {
    const key = `${entry.day}-${entry.phase}`;
    if (!byKey.has(key)) {
      byKey.set(key, { key, day: entry.day, phase: entry.phase, entries: [] });
      order.push(key);
    }
    byKey.get(key).entries.push({ entry, idx });
  });
  return order
    .slice()
    .reverse()
    .map(key => {
      const group = byKey.get(key);
      const entries = filter === 'all' ? group.entries : group.entries.filter(({ entry }) => entry.type === filter);
      return { ...group, entries };
    })
    .filter(g => g.entries.length > 0);
}

/** 单个分组：折叠标题 + 条目列表。当前阶段默认展开，历史阶段默认折叠，点击可切换。SPEC §16.2 */
function renderLogGroup(group, currentKey) {
  const label = `第${group.day}${group.phase === 'night' ? '夜' : '天'}`;
  const isOpen = group.key in logGroupOpen ? logGroupOpen[group.key] : group.key === currentKey;
  const entriesHtml = group.entries.map(({ entry, idx }) => renderLogEntryRow(entry, idx)).join('');
  return `
    <div class="log-group">
      <button type="button" class="log-group-header" data-action="toggle-log-group" data-key="${escapeAttr(group.key)}" aria-expanded="${isOpen}">
        <span>${label}</span>
        <span class="log-group-count">${group.entries.length} 条 ${isOpen ? '▾' : '▸'}</span>
      </button>
      <div class="log-group-body"${isOpen ? '' : ' hidden'}>${entriesHtml}</div>
    </div>
  `;
}

/**
 * 单条日志。备注可删除（先执行 + 撤销条）；系统 / 技能 / 死亡 / 警告条目为审计
 * 轨迹，不可编辑或删除。SPEC §16.2
 */
function renderLogEntryRow(entry, idx) {
  const deleteBtn = entry.type === 'note'
    ? `<button type="button" class="btn btn-ghost btn-sm" data-action="delete-note" data-index="${idx}" aria-label="删除备注">删除</button>`
    : '';
  return `
    <div class="log-entry log-entry-${entry.type}">
      <span class="tag tag-outline">${LOG_TYPE_LABEL[entry.type]}</span>
      <span class="log-entry-text">${escapeText(entry.text)}</span>
      ${deleteBtn}
    </div>
  `;
}

/** 切换筛选芯片。纯 UI 状态，不入撤销栈。 */
function setLogFilter(filter) {
  logFilter = filter;
  render();
}

/** 展开 / 折叠某个分组。纯 UI 状态，不入撤销栈。SPEC §16.2 */
function toggleLogGroup(key) {
  const currentKey = `${state.day}-${state.phase}`;
  const current = key in logGroupOpen ? logGroupOpen[key] : key === currentKey;
  logGroupOpen[key] = !current;
  render();
}

/** 胜方选项显示名。SPEC §17 —— 胜负由法官在战报页点选，应用不做自动判定。 */
const WINNER_OPTIONS = [
  { key: 'good', label: '好人胜' },
  { key: 'wolf', label: '狼人胜' },
  { key: 'draw', label: '平局' },
];

/**
 * 战报页：法官点选胜方、完整名单（座位 / 姓名 / 身份 / 死因 / 死亡时间）、
 * 总时长与天数、完整日志；开新局（长按）/ 返回。SPEC §4.4
 */
function renderReport() {
  const host = document.getElementById('screen-report');
  if (!host) return;

  const winnerButtonsHtml = WINNER_OPTIONS.map(w => `
    <button type="button" class="btn btn-secondary${state.winner === w.key ? ' is-active' : ''}" data-action="set-winner" data-winner="${w.key}">${w.label}</button>
  `).join('');

  const rosterHtml = state.players.map(renderReportRosterRow).join('');
  const logHtml = renderReportLogHtml();
  const durationText = formatDuration(reportDurationMs());

  host.innerHTML = `
    <div class="wrap report-screen">
      <div class="setup-header">
        <h1>战报</h1>
        <div class="actions">
          <button type="button" class="btn btn-secondary btn-longpress" data-action="new-game-report" data-longpress="true">
            <span>开新局</span>
          </button>
          <button type="button" class="btn btn-secondary" data-action="return-to-game-report">‹ 返回</button>
        </div>
      </div>

      <section class="report-section">
        <h2 class="report-section-title">胜方</h2>
        <div class="actions" role="group" aria-label="胜方">${winnerButtonsHtml}</div>
      </section>

      <section class="report-section">
        <p class="note">${state.playerCount}人局 · 共${state.day}天 · 用时 ${durationText}</p>
      </section>

      <section class="report-section">
        <h2 class="report-section-title">名单</h2>
        <div class="report-roster">${rosterHtml}</div>
      </section>

      <section class="report-section report-log-section">
        <h2 class="report-section-title">完整日志</h2>
        <div class="report-log">${logHtml}</div>
      </section>
    </div>
  `;

  bindLongPressGuard(host.querySelector('[data-action="new-game-report"]'), startNewGameFromReport);
}

/** 名单单行：座位 / 姓名 / 身份 / 死因（或存活）/ 死亡时间。SPEC §4.4 */
function renderReportRosterRow(p) {
  const roleId = p.effectiveRoleId ?? p.roleId;
  const roleLabel = roleId ? (ROLE_MAP[roleId]?.name ?? '未知身份') : '未知身份';
  const nameLabel = p.name || `座位${p.seat}`;
  const statusLabel = p.alive ? '存活' : escapeText(p.deathReason || '其他');
  const timeLabel = p.alive ? '—' : `第${p.deathDay}${p.deathPhase === 'night' ? '夜' : '天'}`;
  return `
    <div class="report-roster-row${p.alive ? '' : ' is-dead'}">
      <span class="report-roster-seat">${p.seat}号</span>
      <span class="report-roster-name">${escapeText(nameLabel)}</span>
      <span class="report-roster-role">${escapeText(roleLabel)}</span>
      <span class="report-roster-status">${statusLabel}</span>
      <span class="report-roster-time">${timeLabel}</span>
    </div>
  `;
}

/**
 * 完整日志的只读展示：按 `第N夜` / `第N天` 分组，组内按写入顺序（时间正序），
 * 组间按发生顺序正序排列（不折叠，「完整」二字即指不筛不藏）。SPEC §4.4
 */
function renderReportLogHtml() {
  if (!state.log.length) return '<p class="note">暂无日志</p>';
  const groups = [];
  let current = null;
  state.log.forEach(entry => {
    const key = `${entry.day}-${entry.phase}`;
    if (!current || current.key !== key) {
      current = { key, day: entry.day, phase: entry.phase, entries: [] };
      groups.push(current);
    }
    current.entries.push(entry);
  });
  return groups.map(g => {
    const label = `第${g.day}${g.phase === 'night' ? '夜' : '天'}`;
    const rowsHtml = g.entries.map(e => `
      <div class="log-entry log-entry-${e.type}">
        <span class="tag tag-outline">${LOG_TYPE_LABEL[e.type]}</span>
        <span class="log-entry-text">${escapeText(e.text)}</span>
      </div>
    `).join('');
    return `
      <div class="log-group">
        <div class="log-group-header-static">${label}</div>
        <div class="log-group-body">${rowsHtml}</div>
      </div>
    `;
  }).join('');
}

/** 已进行的总时长（毫秒），从 startedAt 到当前。未记录开始时间（旧存档）时为 0。SPEC §4.4 */
function reportDurationMs() {
  if (state.startedAt == null) return 0;
  return Math.max(0, Date.now() - state.startedAt);
}

/** mm 分 ss 秒格式化；超过一小时附带小时数。 */
function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}小时${mm}分${ss}秒` : `${m}分${ss}秒`;
}

/** 法官点选胜方。纯记录，不驱动任何自动判定逻辑。SPEC §17 */
function setWinner(winner) {
  update({ winner }, { snapshot: false });
}

/** 返回：对局继续，误触可恢复。重新申请屏幕常亮（长按结束时已释放）。SPEC §4.4 / §8.1 */
function returnToGameFromReport() {
  gotoScreen('game');
  requestWakeLock();
}

/** 开新局：清空存档槽，回到设置向导。破坏性操作，经长按守护确认。SPEC §4.4 / §8.2 / §11.1 */
function startNewGameFromReport() {
  releaseWakeLock();
  clearGame();
  pendingResume = null;
  resetGameUiState();
  update(() => createInitialState(), { snapshot: false });
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
  const { selectable, selected } = activeSelectableSeats();
  const pulsing = alertPulseSeats();
  const speakingSeat = state.timer.mode === 'speech' ? state.timer.speechSeat : null;
  grid.innerHTML = state.players.map(p => renderPlayerCard(p, columns, selectable, selected, pulsing, speakingSeat)).join('');

  // 长按 550ms 标记阵亡，仅绑定于折叠态的存活卡片；配对 / 白天主动行为选择进行中时不绑定，
  // 避免与点选目标手势冲突。SPEC §8.3
  if (!loverPairMode && !dayActionMode) {
    grid.querySelectorAll('button.player-card:not(.is-dead)').forEach(el => {
      bindDeathLongPress(el, Number(el.dataset.seat));
    });
  }
}

/**
 * 当前是否处于需要点选目标的状态（夜晚步骤 / 天亮死亡提案增补 / 开枪触发），
 * 返回可点选 / 已选中的座位集合。SPEC §4.2 / §4.3 / §5.4 / §8.3
 */
function activeSelectableSeats() {
  const empty = { selectable: new Set(), selected: new Set() };
  if (loverPairMode) return empty;

  if (state.phase === 'night') {
    const steps = state.nightSteps;
    const stepId = steps[state.stepIndex];
    if (!stepId) return empty;

    if (stepId === 'witch') {
      if (witchChoice !== 'poison') return empty;
      const alive = new Set(state.players.filter(p => p.alive).map(p => p.seat));
      return { selectable: alive, selected: new Set(witchPoisonTarget != null ? [witchPoisonTarget] : []) };
    }

    const meta = STEP_META[stepId];
    if (!meta || meta.targets === 0) return empty;
    const alive = new Set(state.players.filter(p => p.alive).map(p => p.seat));
    return { selectable: alive, selected: new Set(nightStepTargets) };
  }

  if (state.phase === 'day' && state.daySubPhase === 'deathReview') {
    const alive = new Set(state.players.filter(p => p.alive).map(p => p.seat));
    const pending = new Set(state.pendingDeaths.map(d => d.seat));
    const selectable = new Set([...alive].filter(s => !pending.has(s)));
    return { selectable, selected: pending };
  }

  if (state.phase === 'day' && state.daySubPhase === 'triggers' && state.triggerQueue[0]?.type === 'shot') {
    const alive = new Set(state.players.filter(p => p.alive).map(p => p.seat));
    return { selectable: alive, selected: new Set() };
  }

  if (state.phase === 'day' && (dayActionMode === 'duelTarget' || dayActionMode === 'wwkTarget')) {
    const alive = new Set(state.players.filter(p => p.alive && p.seat !== dayActionSeat).map(p => p.seat));
    return { selectable: alive, selected: new Set() };
  }

  if (state.phase === 'day' && dayActionMode === 'wolfSelfDestructPick') {
    const eligible = new Set(eligibleDayActionPlayers('selfDestruct').map(p => p.seat));
    return { selectable: eligible, selected: new Set() };
  }

  return empty;
}

/** 单张玩家卡片：折叠 / 展开态，按存活与人数密度分派。SPEC §12.2 / §8.3 / §10.2 */
function renderPlayerCard(p, columns, selectableSeats = new Set(), selectedSeats = new Set(), pulseSeats = new Set(), speakingSeat = null) {
  const role = p.roleId ? ROLE_MAP[p.roleId] : null;
  const roleName = role ? role.name : '未知身份';
  const displayName = escapeText(p.name || `${p.seat}号`);
  const pulseClass = pulseSeats.has(p.seat) ? ' is-pulse' : '';
  const speakingClass = p.alive && speakingSeat === p.seat ? ' is-current-speaker' : '';

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
    const isPendingAdd = state.phase === 'day' && state.daySubPhase === 'deathReview';
    const chipAction = isPendingAdd ? 'add-pending-death' : 'mark-dead';
    return `
      <div class="player-card player-card-expanded" data-seat="${p.seat}">
        <div class="player-card-expanded-header">
          <span class="player-card-seat">${p.seat}号 ${displayName} · 标记阵亡</span>
          <button type="button" class="btn btn-ghost btn-sm" data-action="cancel-death-picker">取消</button>
        </div>
        <div class="death-reason-chips">
          ${DEATH_REASONS.map(r => `
            <button type="button" class="chip" data-action="${chipAction}" data-seat="${p.seat}" data-reason="${escapeAttr(r)}">${escapeText(r)}</button>
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
      <button type="button" class="player-card is-dead${pulseClass}" data-action="toggle-alive-expand" data-seat="${p.seat}">
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

  const isSelectable = selectableSeats.has(p.seat);
  const isSelected = selectedSeats.has(p.seat);
  const targetClass = `${isSelectable ? ' is-selectable' : ''}${isSelected ? ' is-selected' : ''}${pulseClass}${speakingClass}`;
  return `
    <button type="button" class="player-card${targetClass}" data-action="toggle-alive-expand" data-seat="${p.seat}">
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

/** 展开面板内的技能状态：图标标签 + ✓/✗，点击可手动修正。SPEC §6 */
function renderSkillStatusHtml(p, role) {
  if (!role || !role.skills.length) return '<p class="note">无可追踪技能</p>';
  const chips = role.skills.filter(key => key !== 'lastTarget').map(key => {
    const used = isSkillUsed(p, key);
    const label = SKILL_LABELS[key] ?? key;
    return `<button type="button" class="skill-chip skill-chip-toggle${used ? ' is-used' : ''}" data-action="toggle-skill" data-seat="${p.seat}" data-skill="${key}">${escapeText(label)}${used ? ' ✗' : ' ✓'}</button>`;
  }).join('');
  return chips ? `<div class="skill-status-row">${chips}</div>` : '<p class="note">无可追踪技能</p>';
}

/** 手动修正任一技能状态（辅助型原则 —— 自动消耗永远可覆盖）。SPEC §6 */
function toggleSkill(seat, key) {
  const player = state.players.find(p => p.seat === seat);
  if (!player) return;
  const used = isSkillUsed(player, key);
  let players;
  if (key === 'revealed') {
    players = state.players.map(p => p.seat === seat ? { ...p, flags: { ...p.flags, idiotRevealed: !used } } : p);
  } else if (key === 'active') {
    players = state.players.map(p => p.seat === seat ? { ...p, flags: { ...p.flags, foxDisabled: !used } } : p);
  } else {
    players = state.players.map(p => p.seat === seat ? { ...p, skills: { ...p.skills, [key]: used } } : p);
  }
  update({ players });
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
  persistState();
}

/** 输入框逐字符更新：不入历史栈、不整屏重渲染，避免打字时丢失焦点/光标。 */
function setPlayerNameSilently(seat, name) {
  const players = state.players.map(p => (p.seat === seat ? { ...p, name } : p));
  state = { ...state, players };
  persistState();
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
    p.seat === seat ? { ...p, roleId, effectiveRoleId: roleId, skills: initSkills(roleId) } : p);
  identitySelectedSeat = null;
  update({ players });
}

function clearRole4(seat) {
  const players = state.players.map(p =>
    p.seat === seat ? { ...p, roleId: null, effectiveRoleId: null, skills: {} } : p);
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
    return { ...p, roleId, effectiveRoleId: roleId, skills: initSkills(roleId) };
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

/** 手动配对情侣。局内（非设置阶段）写入日志，SPEC §5.3 / §5.4 —— 驱动殉情走 cascadeDeaths。 */
function pairLovers(seatA, seatB) {
  const players = state.players.map(p => {
    if (p.seat === seatA) return { ...p, loverSeat: seatB };
    if (p.seat === seatB) return { ...p, loverSeat: seatA };
    return p;
  });
  if (state.screen === 'game') {
    const entry = {
      day: state.day, phase: state.phase, type: 'system', actor: null, targets: [seatA, seatB],
      text: `${seatA}号 与 ${seatB}号 设为情侣`, result: null, ts: Date.now(),
    };
    update({ players, log: [...state.log, entry] });
    return;
  }
  update({ players });
}

function unpairLovers(seat) {
  const player = state.players.find(p => p.seat === seat);
  if (!player || player.loverSeat == null) return;
  const otherSeat = player.loverSeat;
  const players = state.players.map(p =>
    (p.seat === seat || p.seat === otherSeat) ? { ...p, loverSeat: null } : p);
  if (state.screen === 'game') {
    const entry = {
      day: state.day, phase: state.phase, type: 'system', actor: null, targets: [seat, otherSeat],
      text: `解除 ${seat}号 与 ${otherSeat}号 的情侣关系`, result: null, ts: Date.now(),
    };
    update({ players, log: [...state.log, entry] });
    return;
  }
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
  pendingResume = null;
  resetGameUiState();
  update({
    screen: 'game',
    log: [...state.log, entry],
    startedAt: Date.now(),
    nightSteps: activeNightSteps(state),
  });
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
  dayActionMode = null;
  dayActionSeat = null;
  dayActionTarget = null;
  resetNightStepUiState();
}

/** 重置当前夜晚步骤尚未确认的目标选择。步骤切换 / 进出局内时调用。 */
function resetNightStepUiState() {
  nightStepTargets = [];
  witchChoice = null;
  witchPoisonTarget = null;
}

/**
 * 点击存活/阵亡折叠卡片：情侣配对模式下路由至配对逻辑；
 * 夜晚步骤进行中点击存活卡片则路由至目标选择（SPEC §4.2 / §8.4）；
 * 否则切换信息面板展开。SPEC §8.3
 */
function handleCardTap(seat) {
  if (loverPairMode) {
    handleLoverSeatClick(seat);
    return;
  }

  const player = state.players.find(p => p.seat === seat);

  if (dayActionMode === 'duelTarget' && player?.alive && seat !== dayActionSeat) {
    dayActionTarget = seat;
    dayActionMode = 'duelConfirm';
    render();
    return;
  }

  if (dayActionMode === 'wwkTarget' && player?.alive && seat !== dayActionSeat) {
    resolveWhiteWolfKing(dayActionSeat, seat);
    return;
  }

  if (dayActionMode === 'wolfSelfDestructPick' && player?.alive
      && eligibleDayActionPlayers('selfDestruct').some(p => p.seat === seat)) {
    resolveWolfSelfDestruct(seat);
    return;
  }

  if (dayActionMode) return;

  if (state.phase === 'night' && player?.alive) {
    const steps = state.nightSteps;
    const stepId = steps[state.stepIndex];
    if (stepId && (stepId === 'witch' ? witchChoice === 'poison' : STEP_META[stepId].targets > 0)) {
      selectStepTarget(seat, stepId);
      return;
    }
  }

  if (state.phase === 'day' && state.daySubPhase === 'deathReview' && player?.alive) {
    const alreadyPending = state.pendingDeaths.some(d => d.seat === seat);
    if (!alreadyPending) {
      gameDeathPickerSeat = seat;
      gameExpandedSeat = null;
      render();
      return;
    }
  }

  if (state.phase === 'day' && state.daySubPhase === 'triggers' && player?.alive
      && state.triggerQueue[0]?.type === 'shot') {
    resolveShotTrigger(seat);
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
  // 局内「修改身份」可能是对同一身份的重新确认（而非真正更换）——此时保留已消耗的
  // 技能状态，避免误将已用的解药/开枪等悄悄恢复为可用。仅真正更换身份时才重建 skills。
  const players = state.players.map(p =>
    p.seat === seat
      ? { ...p, roleId, effectiveRoleId: roleId, skills: roleId === p.roleId ? p.skills : initSkills(roleId) }
      : p);
  gameRoleEditSeat = null;
  update({ players });
}

function clearRoleGame(seat) {
  const players = state.players.map(p =>
    p.seat === seat ? { ...p, roleId: null, effectiveRoleId: null, skills: {} } : p);
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
// 流程 —— 夜晚                                          SPEC §4.2 / §9
// ══════════════════════════════════════════════════════════════════

/**
 * 点选当前夜晚步骤的目标座位。含身份隐式补全（SPEC §8.4）：
 * 若该座位身份未知，补全为当前步骤对应的角色。
 */
function selectStepTarget(seat, stepId) {
  let players = state.players;
  const player = players.find(p => p.seat === seat);
  if (player && player.roleId == null) {
    const role = roleForNightStep(stepId);
    if (role) {
      players = players.map(p =>
        p.seat === seat ? { ...p, roleId: role.id, effectiveRoleId: role.id, skills: initSkills(role.id) } : p);
    }
  }

  if (stepId === 'witch') {
    witchPoisonTarget = seat;
  } else {
    const meta = STEP_META[stepId];
    const idx = nightStepTargets.indexOf(seat);
    if (idx >= 0) {
      nightStepTargets = nightStepTargets.filter(s => s !== seat);
    } else if (nightStepTargets.length >= meta.targets) {
      nightStepTargets = [...nightStepTargets.slice(1), seat];
    } else {
      nightStepTargets = [...nightStepTargets, seat];
    }
  }

  if (players !== state.players) {
    update({ players });
  } else {
    render();
  }
}

/** 结构化步骤日志文本，格式如「预言家查验 5号 → 狼人」。SPEC §9 / §16.1 */
function buildStepLogEntry(stepId, actorSeat, targets, resultText) {
  const meta = STEP_META[stepId];
  const verb = STEP_LOG_VERB[stepId] ?? '';
  const targetsLabel = targets.length ? targets.map(s => `${s}号`).join('·') : '';
  const suffix = targetsLabel ? ` ${targetsLabel}` : '';
  const text = resultText != null
    ? `${meta.name}${verb}${suffix} → ${resultText}`
    : `${meta.name}${verb}${suffix}`;
  return {
    day: state.day, phase: state.phase, type: 'skill',
    actor: actorSeat, targets: [...targets], text, result: resultText ?? null, ts: Date.now(),
  };
}

/** 确认当前夜晚步骤：落库行动 / 技能消耗，写入日志，推进步骤指针。SPEC §4.2 / §6 */
function confirmNightStep() {
  const steps = state.nightSteps;
  const stepId = steps[state.stepIndex];
  if (!stepId) return;

  if (stepId === 'witch') {
    confirmWitchStep();
    return;
  }

  const meta = STEP_META[stepId];
  if (meta.targets > 0 && nightStepTargets.length < meta.targets) return;

  const actorSeat = stepActorSeat(stepId);
  let players = state.players;
  let nightActions = state.nightActions;
  let resultText = null;
  let logTargets = nightStepTargets;
  let stepAlerts = [];

  switch (stepId) {
    case 'wolfkill': {
      const target = nightStepTargets[0];
      nightActions = { ...nightActions, wolfTarget: target };
      break;
    }
    case 'guard': {
      const target = nightStepTargets[0];
      stepAlerts = validateAction(state, 'guard', { target })
        .filter(w => ALERT_WARNING_TYPES.has(w.type))
        .map(w => ({ ...w, seat: target }));
      nightActions = { ...nightActions, guardTarget: target };
      break;
    }
    case 'charm': {
      const target = nightStepTargets[0];
      players = players.map(p => p.seat === target ? { ...p, charmedBySeat: actorSeat } : p);
      nightActions = { ...nightActions, charmTarget: target };
      break;
    }
    case 'mechwolf': {
      const target = nightStepTargets[0];
      players = players.map(p =>
        p.seat === actorSeat ? { ...p, skills: { ...p.skills, copy: false } } : p);
      nightActions = { ...nightActions, mechwolfTarget: target };
      break;
    }
    case 'cupid': {
      const [a, b] = nightStepTargets;
      players = players.map(p => {
        if (p.seat === a) return { ...p, loverSeat: b };
        if (p.seat === b) return { ...p, loverSeat: a };
        if (p.seat === actorSeat) return { ...p, skills: { ...p.skills, link: false } };
        return p;
      });
      nightActions = { ...nightActions, cupidLink: [a, b] };
      break;
    }
    case 'magician': {
      const [a, b] = nightStepTargets;
      nightActions = { ...nightActions, magicianSwap: [a, b] };
      break;
    }
    case 'seer': {
      const info = computeStepInfo(state, 'seer', nightStepTargets);
      nightActions = { ...nightActions, seerTarget: nightStepTargets[0] };
      resultText = info.known ? info.result : '未知身份 — 请手动判断';
      break;
    }
    case 'psychic': {
      const info = computeStepInfo(state, 'psychic', nightStepTargets);
      nightActions = { ...nightActions, psychicTarget: nightStepTargets[0] };
      resultText = info.known ? info.result : '未知身份 — 请手动判断';
      break;
    }
    case 'fox': {
      const info = computeStepInfo(state, 'fox', nightStepTargets);
      if (info.known && info.disablesFox && actorSeat != null) {
        players = players.map(p =>
          p.seat === actorSeat ? { ...p, flags: { ...p.flags, foxDisabled: true } } : p);
      }
      nightActions = { ...nightActions, foxStart: nightStepTargets[0] };
      resultText = info.known ? info.result : '未知身份 — 请手动判断';
      break;
    }
    case 'gravekeeper': {
      const info = computeStepInfo(state, 'gravekeeper', []);
      if (info.known) logTargets = [info.seat];
      resultText = info.known ? info.result : '未知身份 — 请手动判断';
      break;
    }
    case 'bear': {
      const info = computeStepInfo(state, 'bear', []);
      resultText = info.known ? info.result : '未知身份 — 请手动判断';
      if (info.known && info.growl && actorSeat != null) {
        stepAlerts = [{ type: 'bearGrowl', seat: actorSeat, text: `${actorSeat}号（熊）应当咆哮` }];
      }
      break;
    }
    default: break;
  }

  const entry = buildStepLogEntry(stepId, actorSeat, logTargets, resultText);
  const { alertQueue, logAppend } = appendAlerts(stepAlerts);
  const patch = {
    players, nightActions,
    log: [...state.log, entry, ...logAppend],
    stepIndex: state.stepIndex + 1,
    alertQueue,
  };
  if (stepId === 'guard') patch.lastGuardTarget = nightStepTargets[0];

  resetNightStepUiState();
  update(patch);
  if (stepAlerts.length) notifyAlert();
}

/** 女巫步骤确认：解药 / 毒药 / 不使用，消耗对应技能槽。SPEC §6 / §9 */
function confirmWitchStep() {
  const actorSeat = stepActorSeat('witch');
  const nightDeathSeat = state.nightActions.wolfTarget ?? null;

  let witchAction;
  let targets = [];
  let resultText = null;
  let players = state.players;
  let warnings = [];

  if (witchChoice === 'save') {
    if (nightDeathSeat == null) return;
    witchAction = { type: 'save', target: nightDeathSeat };
    targets = [nightDeathSeat];
    resultText = `${nightDeathSeat}号`;
    warnings = validateAction(state, 'witch', { type: 'save', target: nightDeathSeat });
    if (actorSeat != null) {
      players = players.map(p =>
        p.seat === actorSeat ? { ...p, skills: { ...p.skills, antidote: false } } : p);
    }
  } else if (witchChoice === 'poison') {
    if (witchPoisonTarget == null) return;
    witchAction = { type: 'poison', target: witchPoisonTarget };
    targets = [witchPoisonTarget];
    resultText = `${witchPoisonTarget}号`;
    warnings = validateAction(state, 'witch', { type: 'poison', target: witchPoisonTarget });
    if (actorSeat != null) {
      players = players.map(p =>
        p.seat === actorSeat ? { ...p, skills: { ...p.skills, poison: false } } : p);
    }
  } else if (witchChoice === 'skip') {
    witchAction = { type: 'skip' };
  } else {
    return;
  }

  const verb = witchChoice === 'save' ? '使用解药' : witchChoice === 'poison' ? '使用毒药' : '不使用';
  const text = resultText != null ? `女巫${verb} → ${resultText}` : `女巫${verb}`;
  const entry = {
    day: state.day, phase: state.phase, type: 'skill',
    actor: actorSeat, targets, text, result: resultText, ts: Date.now(),
  };

  const stepAlerts = warnings.filter(w => ALERT_WARNING_TYPES.has(w.type)).map(w => ({ ...w, seat: actorSeat }));
  const { alertQueue, logAppend } = appendAlerts(stepAlerts);

  resetNightStepUiState();
  update({
    players,
    nightActions: { ...state.nightActions, witchAction },
    log: [...state.log, entry, ...logAppend],
    stepIndex: state.stepIndex + 1,
    alertQueue,
  });
  if (stepAlerts.length) notifyAlert();
}

/** 女巫步骤：选择解药 / 毒药 / 不使用。选择毒药后进入目标点选。SPEC §9 */
function chooseWitchAction(choice) {
  witchChoice = choice;
  witchPoisonTarget = null;
  render();
}

/** 跳过当前夜晚步骤，不落库任何行动，仍写入日志留痕。SPEC §4.2 */
function skipNightStep() {
  const steps = state.nightSteps;
  const stepId = steps[state.stepIndex];
  if (!stepId) return;
  const meta = STEP_META[stepId];
  const actorSeat = stepActorSeat(stepId);
  const entry = {
    day: state.day, phase: state.phase, type: 'skill',
    actor: actorSeat, targets: [], text: `${meta.name} 跳过`, result: null, ts: Date.now(),
  };
  resetNightStepUiState();
  update({ stepIndex: state.stepIndex + 1, log: [...state.log, entry] });
}

/**
 * 天亮入口：全部夜晚步骤完成后调用结算引擎，产出死亡提案供法官核对确认。
 * SPEC §4.2 / §4.3 / §5.1
 */
function endNight() {
  const { deaths, warnings } = resolveDawn(state);
  const entry = {
    day: state.day, phase: state.phase, type: 'system',
    actor: null, targets: [], text: '天亮了', result: null, ts: Date.now(),
  };

  const stepAlerts = warnings.filter(w => ALERT_WARNING_TYPES.has(w.type));
  const { alertQueue, logAppend } = appendAlerts(stepAlerts);

  resetNightStepUiState();
  update({
    phase: 'day',
    stepIndex: 0,
    daySubPhase: 'deathReview',
    pendingDeaths: deaths,
    alertQueue,
    log: [...state.log, entry, ...logAppend],
  });
  if (stepAlerts.length) notifyAlert();
}

// ══════════════════════════════════════════════════════════════════
// 流程 —— 白天：死亡结算确认 + 触发队列 + 每日随机首发言（withAutoFirstSpeaker）
// SPEC §4.3 / §5.4 / §15；骑士决斗 / 自爆 / 放逐 / 进入下一夜见后续小节
// ══════════════════════════════════════════════════════════════════

/** 死因是否符合「白痴翻牌免死」条件：仅死因为被投票且未翻过牌。SPEC §5.4 */
function isIdiotReveal(death) {
  if (death.reason !== '被投票') return false;
  const player = state.players.find(p => p.seat === death.seat);
  const role = ROLE_MAP[player?.effectiveRoleId ?? player?.roleId];
  return role?.deathTrigger === 'idiotReveal' && !player?.flags?.idiotRevealed;
}

/** 扫描一批死亡中因非常规死因被抑制开枪的猎人 / 狼王，产出警报通道条目。SPEC §5.4 / §10.3 */
function detectSuppressedShots(deathsList, playersSnapshot) {
  const alerts = [];
  for (const d of deathsList) {
    const player = playersSnapshot.find(p => p.seat === d.seat);
    if (!player) continue;
    const role = ROLE_MAP[player.effectiveRoleId ?? player.roleId];
    if (role?.deathTrigger !== 'shot') continue;
    if (player.skills?.shot === false) continue;
    if (!ABNORMAL_DEATH_REASONS.includes(d.reason)) continue;
    if (!state.rules?.abnormalDeathBlocksShot) continue;
    alerts.push({
      type: 'shotSuppressed', seat: d.seat,
      text: `${d.seat}号（${role.name}）因${d.reason}死亡，开枪被抑制（当前规则）`,
    });
  }
  return alerts;
}

/**
 * 法官确认天亮死亡提案：落库死亡（白痴触发者不落库，仅入触发队列，SPEC §5.4）、
 * 构建死亡触发队列、检测被抑制的开枪并接入警报通道。
 */
function confirmPendingDeaths() {
  const deaths = state.pendingDeaths;
  const now = Date.now();

  const idiotSeats = new Set(deaths.filter(isIdiotReveal).map(d => d.seat));
  const applied = deaths.filter(d => !idiotSeats.has(d.seat));
  const reasonBySeat = new Map(applied.map(d => [d.seat, d.reason]));
  const players = state.players.map(p =>
    reasonBySeat.has(p.seat)
      ? { ...p, alive: false, deathReason: reasonBySeat.get(p.seat), deathDay: state.day, deathPhase: state.phase }
      : p);

  const deathEntries = applied.map(d => ({
    day: state.day, phase: state.phase, type: 'death', actor: null, targets: [d.seat],
    text: `${d.seat}号 ${d.reason}`, result: null, ts: now,
  }));

  const triggerQueue = buildTriggerQueue({ ...state, players }, deaths);
  const suppressedAlerts = detectSuppressedShots(deaths, players);
  const { alertQueue, logAppend } = appendAlerts(suppressedAlerts);
  const daySubPhase = triggerQueue.length ? 'triggers' : 'main';

  update(withAutoFirstSpeaker({
    players,
    pendingDeaths: [],
    triggerQueue,
    daySubPhase,
    alertQueue,
    log: [...state.log, ...deathEntries, ...logAppend],
  }));
  if (suppressedAlerts.length) notifyAlert();
}

/** 死亡提案增删：移除一条法官不认可的引擎推算条目。SPEC §4.3 / §5.1 */
function removePendingDeath(seat) {
  update({ pendingDeaths: state.pendingDeaths.filter(d => d.seat !== seat) });
}

/** 死亡提案增删：法官手动添加一条死亡（点选存活玩家 → 选择死因）。SPEC §4.3 / §5.1 */
function addPendingDeath(seat, reason) {
  gameDeathPickerSeat = null;
  if (state.pendingDeaths.some(d => d.seat === seat)) { render(); return; }
  const explanation = `${seat}号 ${reason}（法官手动添加）`;
  update({ pendingDeaths: [...state.pendingDeaths, { seat, reason, explanation }] });
}

/**
 * 触发 / 白天行为产生的新死亡落库：应用存活状态、写入死亡日志、
 * 回流殉情 / 魅惑连锁产生的触发继续入队（一次一条），检测被抑制的开枪。
 * SPEC §5.1 步骤 7–9 / §5.4
 *
 * @param {boolean} [advanceOnEmpty] 队列耗尽时是否直接进入下一夜（普通狼人自爆：
 *   白天立即结束，SPEC §4.3 步骤 5 / §5.4）。省略时沿用 state.pendingNightAdvance，
 *   使同一条自爆触发链中后续的开枪 / 翻牌解决仍记得这条链最终要跳到下一夜。
 */
function applyDeathsFromTrigger(players, deathsList, extraLogEntries, remainingQueue, advanceOnEmpty = state.pendingNightAdvance) {
  const now = Date.now();
  const reasonBySeat = new Map(deathsList.map(d => [d.seat, d.reason]));
  const updatedPlayers = players.map(p =>
    reasonBySeat.has(p.seat)
      ? { ...p, alive: false, deathReason: reasonBySeat.get(p.seat), deathDay: state.day, deathPhase: state.phase }
      : p);

  const deathEntries = deathsList.map(d => ({
    day: state.day, phase: state.phase, type: 'death', actor: null, targets: [d.seat],
    text: `${d.seat}号 ${d.reason}`, result: null, ts: now,
  }));

  const newTriggers = buildTriggerQueue({ ...state, players: updatedPlayers }, deathsList);
  const suppressedAlerts = detectSuppressedShots(deathsList, updatedPlayers);
  const { alertQueue, logAppend } = appendAlerts(suppressedAlerts);

  const triggerQueue = [...remainingQueue, ...newTriggers];
  const log = [...state.log, ...extraLogEntries, ...deathEntries, ...logAppend];

  if (triggerQueue.length) {
    update({ players: updatedPlayers, triggerQueue, daySubPhase: 'triggers', pendingNightAdvance: advanceOnEmpty, alertQueue, log });
  } else if (advanceOnEmpty) {
    startNextNight(updatedPlayers, log);
  } else {
    update(withAutoFirstSpeaker({ players: updatedPlayers, triggerQueue, daySubPhase: 'main', alertQueue, log }));
  }
  if (suppressedAlerts.length) notifyAlert();
}

/** 猎人 / 狼王开枪：点选目标座位 → 结算枪击死亡，回流殉情 / 魅惑连锁。SPEC §5.4 */
function resolveShotTrigger(targetSeat) {
  const current = state.triggerQueue[0];
  if (!current || current.type !== 'shot') return;
  const rest = state.triggerQueue.slice(1);
  const shooter = state.players.find(p => p.seat === current.seat);
  const shooterRole = ROLE_MAP[shooter?.effectiveRoleId ?? shooter?.roleId];
  const players = state.players.map(p =>
    p.seat === current.seat ? { ...p, skills: { ...p.skills, shot: false } } : p);

  const shotEntry = {
    day: state.day, phase: state.phase, type: 'skill', actor: current.seat,
    targets: [targetSeat],
    text: `${current.seat}号（${shooterRole?.name ?? ''}）开枪 → ${targetSeat}号`,
    result: null, ts: Date.now(),
  };

  const { deaths } = cascadeDeaths({ ...state, players }, [{ seat: targetSeat, reason: '被枪' }]);
  applyDeathsFromTrigger(players, deaths, [shotEntry], rest);
}

/** 白痴触发：翻牌免死，不死亡，仅置 idiotRevealed 并失去投票权。SPEC §5.4 */
function resolveIdiotReveal() {
  const current = state.triggerQueue[0];
  if (!current || current.type !== 'idiotReveal') return;
  const rest = state.triggerQueue.slice(1);
  const players = state.players.map(p =>
    p.seat === current.seat ? { ...p, flags: { ...p.flags, idiotRevealed: true } } : p);
  const entry = {
    day: state.day, phase: state.phase, type: 'skill', actor: current.seat, targets: [],
    text: `${current.seat}号 翻牌免死，失去投票权`, result: null, ts: Date.now(),
  };
  const log = [...state.log, entry];
  if (rest.length) {
    update({ players, triggerQueue: rest, daySubPhase: 'triggers', log });
  } else if (state.pendingNightAdvance) {
    startNextNight(players, log);
  } else {
    update(withAutoFirstSpeaker({ players, triggerQueue: rest, daySubPhase: 'main', log }));
  }
}

/** 跳过当前触发（选择不开枪 / 不翻牌）。开枪跳过同样消耗技能槽。SPEC §5.4 */
function skipTrigger() {
  const current = state.triggerQueue[0];
  if (!current) return;
  const rest = state.triggerQueue.slice(1);
  let players = state.players;
  let text;
  if (current.type === 'shot') {
    players = players.map(p => p.seat === current.seat ? { ...p, skills: { ...p.skills, shot: false } } : p);
    text = `${current.label} → 选择不开枪`;
  } else {
    text = `${current.label} → 跳过`;
  }
  const entry = {
    day: state.day, phase: state.phase, type: 'skill', actor: current.seat, targets: [],
    text, result: null, ts: Date.now(),
  };
  const log = [...state.log, entry];
  if (rest.length) {
    update({ players, triggerQueue: rest, daySubPhase: 'triggers', log });
  } else if (state.pendingNightAdvance) {
    startNextNight(players, log);
  } else {
    update(withAutoFirstSpeaker({ players, triggerQueue: rest, daySubPhase: 'main', log }));
  }
}

// ══════════════════════════════════════════════════════════════════
// 白天主动行为 —— 骑士决斗 / 白狼王自爆带人 / 狼人自爆 / 进入下一夜   SPEC §4.3 / §5.4
// ══════════════════════════════════════════════════════════════════

/** 取消进行中的白天主动行为选择，不产生任何状态变更。 */
function cancelDayAction() {
  dayActionMode = null;
  dayActionSeat = null;
  dayActionTarget = null;
  render();
}

/** 骑士决斗：进入「选择对手」模式，骑士座位固定为当前唯一合资格行动者。SPEC §5.4 */
function startDuel() {
  const knight = eligibleDayActionPlayers('duel')[0];
  if (!knight) return;
  dayActionMode = 'duelTarget';
  dayActionSeat = knight.seat;
  dayActionTarget = null;
  render();
}

/**
 * 骑士决斗裁定：法官点选胜负（应用不判定，SPEC §1.2）。
 * 骑士获胜 → 对手死亡（被骑士处决）；骑士落败 → 骑士死亡（其他，枚举无更贴切项）。
 * 决斗为一次性技能，无论胜负均消耗。
 */
function resolveDuel(result) {
  const knightSeat = dayActionSeat;
  const opponentSeat = dayActionTarget;
  dayActionMode = null;
  dayActionSeat = null;
  dayActionTarget = null;

  const loserSeat = result === 'knightWins' ? opponentSeat : knightSeat;
  const loserReason = result === 'knightWins' ? '被骑士处决' : '其他';

  const players = state.players.map(p =>
    p.seat === knightSeat ? { ...p, skills: { ...p.skills, duel: false } } : p);

  const entry = {
    day: state.day, phase: state.phase, type: 'skill', actor: knightSeat, targets: [opponentSeat],
    text: `骑士 ${knightSeat}号 与 ${opponentSeat}号 决斗 · ${result === 'knightWins' ? '骑士获胜' : '骑士落败'}`,
    result: null, ts: Date.now(),
  };

  const { deaths } = cascadeDeaths({ ...state, players }, [{ seat: loserSeat, reason: loserReason }]);
  applyDeathsFromTrigger(players, deaths, [entry], state.triggerQueue);
}

/** 白狼王自爆带人：进入「选择目标」模式。SPEC §5.4 */
function startWwk() {
  const wwk = eligibleDayActionPlayers('selfDestructWithTarget')[0];
  if (!wwk) return;
  dayActionMode = 'wwkTarget';
  dayActionSeat = wwk.seat;
  dayActionTarget = null;
  render();
}

/**
 * 白狼王自爆带人：双双死亡（自爆 / 被自爆带走）。白狼王无 deathTrigger，
 * 不产生任何触发（SPEC §5.4 —— 白狼王正常死亡与自爆均不获得触发）。
 */
function resolveWhiteWolfKing(actorSeat, targetSeat) {
  dayActionMode = null;
  dayActionSeat = null;
  dayActionTarget = null;

  const players = state.players.map(p =>
    p.seat === actorSeat ? { ...p, skills: { ...p.skills, selfDestruct: false } } : p);

  const entry = {
    day: state.day, phase: state.phase, type: 'skill', actor: actorSeat, targets: [targetSeat],
    text: `白狼王 ${actorSeat}号 自爆带走 ${targetSeat}号`, result: null, ts: Date.now(),
  };

  const { deaths } = cascadeDeaths({ ...state, players }, [
    { seat: actorSeat, reason: '自爆' },
    { seat: targetSeat, reason: '被自爆带走' },
  ]);
  applyDeathsFromTrigger(players, deaths, [entry], state.triggerQueue);
}

/** 普通狼人自爆：进入「选择自爆者」模式。多名合资格狼人存活时由法官点选。SPEC §5.4 */
function startWolfSelfDestructPick() {
  const wolves = eligibleDayActionPlayers('selfDestruct');
  if (!wolves.length) return;
  dayActionMode = 'wolfSelfDestructPick';
  dayActionSeat = null;
  dayActionTarget = null;
  render();
}

/**
 * 普通狼人自爆：该狼死亡，回流殉情 / 魅惑连锁与触发队列（与天亮结算共用同一链路），
 * 触发队列耗尽后白天立即结束、直接进入下一夜。SPEC §4.3 步骤 5 / §5.4
 */
function resolveWolfSelfDestruct(seat) {
  dayActionMode = null;
  dayActionSeat = null;
  dayActionTarget = null;

  const player = state.players.find(p => p.seat === seat);
  const role = ROLE_MAP[player?.effectiveRoleId ?? player?.roleId];
  const entry = {
    day: state.day, phase: state.phase, type: 'skill', actor: seat, targets: [],
    text: `${seat}号${role ? `（${role.name}）` : ''}自爆`, result: null, ts: Date.now(),
  };

  const { deaths } = cascadeDeaths(state, [{ seat, reason: '自爆' }]);
  applyDeathsFromTrigger(state.players, deaths, [entry], state.triggerQueue, true);
}

/**
 * 「进入下一夜」：day + 1，phase → night，重置夜晚步骤与本夜行动。SPEC §4.3 步骤 7
 */
function endDay() {
  const entry = {
    day: state.day, phase: state.phase, type: 'system', actor: null, targets: [],
    text: '进入下一夜', result: null, ts: Date.now(),
  };
  startNextNight(state.players, [...state.log, entry]);
}

/** 推进到下一夜的共同落点：白天各流程（含普通狼人自爆的提前结束）最终都汇合于此。 */
function startNextNight(players, log) {
  const nextDay = state.day + 1;
  update({
    players,
    day: nextDay,
    phase: 'night',
    stepIndex: 0,
    nightSteps: activeNightSteps({ ...state, players, day: nextDay }),
    daySubPhase: null,
    nightActions: {},
    pendingDeaths: [],
    triggerQueue: [],
    pendingNightAdvance: false,
    log,
  });
}

// ══════════════════════════════════════════════════════════════════
// 死亡与复活
// ══════════════════════════════════════════════════════════════════

/**
 * 标记阵亡（含长按放逐 → 被投票）；情侣殉情 / 魅惑连锁回流 cascadeDeaths
 * （SPEC §5.1 步骤 7–8），并与天亮结算共用同一条死亡触发队列链路（SPEC §5.4）——
 * 白痴翻牌免死者不落库死亡，猎人 / 狼王等触发进入 triggers 子阶段逐条呈现。
 * 先执行 + 撤销条。SPEC §5.4 / §8.2 / §8.3
 */
function markDead(seat, reason) {
  const { deaths } = cascadeDeaths(state, [{ seat, reason }]);
  const idiotSeats = new Set(deaths.filter(isIdiotReveal).map(d => d.seat));
  const applied = deaths.filter(d => !idiotSeats.has(d.seat));
  const reasonBySeat = new Map(applied.map(d => [d.seat, d.reason]));
  const players = state.players.map(p =>
    reasonBySeat.has(p.seat)
      ? { ...p, alive: false, deathReason: reasonBySeat.get(p.seat), deathDay: state.day, deathPhase: state.phase }
      : p);

  const now = Date.now();
  const entries = applied.map(d => ({
    day: state.day, phase: state.phase, type: 'death',
    actor: null, targets: [d.seat], text: `${d.seat}号 ${d.reason}`, result: null, ts: now,
  }));

  const newTriggers = buildTriggerQueue({ ...state, players }, deaths);
  const suppressedAlerts = detectSuppressedShots(deaths, players);
  const { alertQueue, logAppend } = appendAlerts(suppressedAlerts);
  const triggerQueue = [...state.triggerQueue, ...newTriggers];
  const daySubPhase = newTriggers.length ? 'triggers' : state.daySubPhase;

  gameDeathPickerSeat = null;
  gameExpandedSeat = null;
  update({ players, triggerQueue, daySubPhase, alertQueue, log: [...state.log, ...entries, ...logAppend] });
  if (suppressedAlerts.length) notifyAlert();

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
// 计时器 —— 以截止时间戳存储，每次渲染 / 节拍推算剩余，绝不递减整数状态。SPEC §14.1
// ══════════════════════════════════════════════════════════════════

/**
 * 切换自由 / 发言模式；切换时停止当前计时，避免跨模式的截止时间戳残留。
 * 未曾抽取过首发言时切入发言模式，退化为「法官手动指定起始」——默认取存活
 * 座位号最小者、顺时针，随后可用上一位 / 下一位调整到期望的起始座位。SPEC §14.2
 */
function setTimerMode(mode) {
  if (mode === state.timer.mode) return;
  const needsFallbackSeat = mode === 'speech' && state.timer.speechSeat == null;
  const fallbackSeat = needsFallbackSeat
    ? state.players.filter(p => p.alive).map(p => p.seat).sort((a, b) => a - b)[0] ?? null
    : state.timer.speechSeat;
  update({
    timer: {
      ...state.timer, mode, running: false, endsAt: null, pausedRemaining: null,
      speechSeat: mode === 'speech' ? fallbackSeat : state.timer.speechSeat,
      speechDirection: needsFallbackSeat ? 1 : state.timer.speechDirection,
    },
  });
}

/** 自由计时快捷档位：立即以给定秒数开始一段新的倒计时。SPEC §14.2 */
function timerStart(seconds) {
  update({
    timer: {
      ...state.timer, mode: 'free', speechSeat: null,
      endsAt: Date.now() + seconds * 1000, pausedRemaining: null, running: true,
    },
  });
}

/**
 * 播放 / 暂停切换按钮：运行中则暂停（保存剩余毫秒），暂停中则恢复（重算截止时间戳），
 * 空闲时按当前模式以默认时长起步（发言模式复用 startSpeechTimer）。SPEC §14.1
 */
function timerToggle() {
  const t = state.timer;
  if (t.running) {
    update({ timer: { ...t, running: false, endsAt: null, pausedRemaining: timerRemainingMs() } });
    return;
  }
  if (t.pausedRemaining != null) {
    update({ timer: { ...t, running: true, endsAt: Date.now() + t.pausedRemaining, pausedRemaining: null } });
    return;
  }
  if (t.mode === 'speech') {
    if (t.speechSeat == null) return;
    startSpeechTimer(t.speechSeat, t.speechDirection);
  } else {
    timerStart(state.settings.dayTimerDefault);
  }
}

/** ±10s 微调：作用于当前运行中或暂停中的倒计时；空闲时无计时可调，忽略。SPEC §14.2 */
function timerAdjust(deltaSeconds) {
  const t = state.timer;
  const deltaMs = deltaSeconds * 1000;
  if (t.running && t.endsAt != null) {
    update({ timer: { ...t, endsAt: Math.max(Date.now(), t.endsAt + deltaMs) } });
  } else if (t.pausedRemaining != null) {
    update({ timer: { ...t, pausedRemaining: Math.max(0, t.pausedRemaining + deltaMs) } });
  }
}

/** 由截止时间戳 / 暂停剩余量推算当前剩余毫秒，供渲染与到时判定共用。SPEC §14.1 */
function timerRemainingMs() {
  const t = state.timer;
  if (t.running && t.endsAt != null) return Math.max(0, t.endsAt - Date.now());
  if (t.pausedRemaining != null) return t.pausedRemaining;
  return 0;
}

/** 以指定座位与方向开始发言计时，时长取自白天讨论默认时长。SPEC §14.2 / §15 */
function startSpeechTimer(seat, direction) {
  update({
    timer: {
      mode: 'speech', speechSeat: seat, speechDirection: direction,
      endsAt: Date.now() + state.settings.dayTimerDefault * 1000,
      pausedRemaining: null, running: true,
    },
  });
}

function speechNext() { advanceSpeech(1); }
function speechPrev() { advanceSpeech(-1); }

/**
 * 「下一位」按发言方向跳至下一存活座位（跳过阵亡）；「上一位」按相反方向回退。
 * 计时器已启动（运行中或暂停中）时为新发言者重新起满一段计时；尚未开始（预抽取
 * 待确认阶段）时仅调整候选座位，不触发计时。SPEC §14.2
 */
function advanceSpeech(step) {
  const t = state.timer;
  if (t.mode !== 'speech' || t.speechSeat == null) return;
  const dir = step === 1 ? t.speechDirection : -t.speechDirection;
  const nextSeat = nextAliveSeat(state, t.speechSeat, dir);
  if (nextSeat == null) return;

  const active = t.running || t.pausedRemaining != null;
  update({
    timer: {
      ...t,
      speechSeat: nextSeat,
      endsAt: active && t.running ? Date.now() + state.settings.dayTimerDefault * 1000 : null,
      pausedRemaining: active && !t.running ? state.settings.dayTimerDefault * 1000 : null,
    },
  });
}

/** 天亮结算确认后（首次进入白天主阶段）按设置自动抽取每日随机首发言，写入日志。SPEC §15 */
function withAutoFirstSpeaker(patch) {
  if (patch.daySubPhase !== 'main' || state.daySubPhase === 'main' || !state.settings.randomFirstSpeaker) {
    return patch;
  }
  const pick = pickFirstSpeaker({ ...state, players: patch.players ?? state.players });
  if (!pick) return patch;
  return { ...patch, ...firstSpeakerPatch(pick, patch.log ?? state.log) };
}

/** 「重新抽取」：法官手动重新抽取本轮首发言。SPEC §15 */
function redrawFirstSpeaker() {
  const pick = pickFirstSpeaker(state);
  if (!pick) return;
  update(firstSpeakerPatch(pick, state.log));
}

/** 构造首发言抽取结果对应的 timer / log 状态补丁，供自动与手动重抽共用。SPEC §15 */
function firstSpeakerPatch(pick, log) {
  const dirLabel = pick.direction === 1 ? '顺时针' : '逆时针';
  const entry = {
    day: state.day, phase: 'day', type: 'system', actor: null, targets: [pick.seat],
    text: `本轮发言：${pick.seat}号 开始 · ${dirLabel}`, result: null, ts: Date.now(),
  };
  return {
    timer: {
      ...state.timer, mode: 'speech',
      speechSeat: pick.seat, speechDirection: pick.direction,
      running: false, endsAt: null, pausedRemaining: null,
    },
    log: [...log, entry],
  };
}

/** 计时归零：接入警报通道（强视觉闪烁 + 可用时震动 + 可选提示音），非阻断。SPEC §10.3 / §14.3 */
function handleTimerExpired() {
  const seat = state.timer.mode === 'speech' ? state.timer.speechSeat : undefined;
  const { alertQueue, logAppend } = appendAlerts([{ type: 'timerExpired', seat, text: '计时时间到' }]);
  update({
    timer: { ...state.timer, running: false, endsAt: null, pausedRemaining: 0 },
    alertQueue,
    log: [...state.log, ...logAppend],
  });
  notifyAlert();
}

/**
 * 计时显示节拍：每 250ms 检查一次，仅在局内界面且计时运行中才动作。
 * 到时触发警报（走 update() 全量重渲染）；未到时仅直接更新剩余时间文本节点，
 * 不调用 update()，避免每个节拍都写入 localStorage 与重绘整屏。SPEC §14.1
 */
function tickTimer() {
  if (state.screen !== 'game' || !state.timer.running) return;
  const remaining = timerRemainingMs();
  if (remaining <= 0) {
    handleTimerExpired();
    return;
  }
  const el = document.getElementById('timer-remaining');
  if (el) el.textContent = formatTimerMs(remaining);
}

// ══════════════════════════════════════════════════════════════════
// 警报通道 —— 视觉优先，震动 / 提示音为渐进增强，绝不依赖。SPEC §10
// ══════════════════════════════════════════════════════════════════

/**
 * 把警告对象接入警报通道：追加到 alertQueue，并生成对应的 warning 类型日志
 * 条目（SPEC §10 —— 警报与死亡均写入日志）。调用方负责把返回的 alertQueue
 * 与 logAppend 合入自身的 update() 调用，使警报与触发它的状态变更落入
 * 同一次撤销快照。
 * @param {Array<{type:string, seat?:number|number[], text:string}>} alerts
 */
function appendAlerts(alerts) {
  if (!alerts.length) return { alertQueue: state.alertQueue, logAppend: [] };
  const now = Date.now();
  const logAppend = alerts.map(a => ({
    day: state.day, phase: state.phase, type: 'warning', actor: null,
    targets: a.seat != null ? [].concat(a.seat) : [], text: a.text, result: null, ts: now,
  }));
  return { alertQueue: [...state.alertQueue, ...alerts], logAppend };
}

/** 常驻警告横幅，需法官点击「知道了」确认，不自动消失。SPEC §10.2 */
function dismissAlert() {
  update({ alertQueue: state.alertQueue.slice(1) });
}

/** 新警报到达时的渐进增强通知：卡片脉冲高亮由渲染层依 alertQueue 处理。 */
function notifyAlert() {
  triggerVibration();
  playAlertSound();
}

/** 可用时调用震动，绝不依赖（iOS Safari 不支持 Vibration API）。SPEC §10.1 / §10.2 */
function triggerVibration() {
  if (typeof navigator === 'undefined' || !('vibrate' in navigator)) return;
  try { navigator.vibrate([120, 60, 120]); } catch { /* 渐进增强，忽略失败 */ }
}

let alertAudioCtx = null;

/** 提示音：设置项，默认关闭 —— 牌桌声响可能泄露信息。SPEC §10.2 */
function playAlertSound() {
  if (!state.settings.soundEnabled) return;
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    alertAudioCtx ??= new AudioCtx();
    const ctx = alertAudioCtx;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 880;
    gain.gain.value = 0.15;
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.18);
  } catch { /* 渐进增强，忽略失败 */ }
}

/** 当前警报横幅关联的座位集合，供玩家网格脉冲高亮。SPEC §10.2 */
function alertPulseSeats() {
  const current = state.alertQueue[0];
  if (!current || current.seat == null) return new Set();
  return new Set([].concat(current.seat));
}

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
    case 'toggle-skill':       toggleSkill(Number(el.dataset.seat), el.dataset.skill); break;
    case 'confirm-night-step': confirmNightStep(); break;
    case 'skip-night-step':    skipNightStep(); break;
    case 'witch-choice':       chooseWitchAction(el.dataset.choice); break;
    case 'end-night':          endNight(); break;
    case 'confirm-pending-deaths': confirmPendingDeaths(); break;
    case 'remove-pending-death':   removePendingDeath(Number(el.dataset.seat)); break;
    case 'add-pending-death':      addPendingDeath(Number(el.dataset.seat), el.dataset.reason); break;
    case 'skip-trigger':           skipTrigger(); break;
    case 'resolve-idiot-reveal':   resolveIdiotReveal(); break;
    case 'start-duel':              startDuel(); break;
    case 'resolve-duel':            resolveDuel(el.dataset.result); break;
    case 'start-wwk':               startWwk(); break;
    case 'start-wolf-selfdestruct': startWolfSelfDestructPick(); break;
    case 'cancel-day-action':       cancelDayAction(); break;
    case 'end-day':                 endDay(); break;
    case 'set-timer-mode':          setTimerMode(el.dataset.mode); break;
    case 'timer-toggle':            timerToggle(); break;
    case 'timer-adjust':            timerAdjust(Number(el.dataset.delta)); break;
    case 'timer-preset':            timerStart(Number(el.dataset.seconds)); break;
    case 'speech-next':             speechNext(); break;
    case 'speech-prev':             speechPrev(); break;
    case 'start-speech-timer':      startSpeechTimer(state.timer.speechSeat, state.timer.speechDirection); break;
    case 'redraw-first-speaker':    redrawFirstSpeaker(); break;
    case 'dismiss-alert':          dismissAlert(); break;
    case 'set-log-filter':     setLogFilter(el.dataset.filter); break;
    case 'toggle-log-group':   toggleLogGroup(el.dataset.key); break;
    case 'add-note': {
      const input = document.getElementById('log-note-input');
      if (input) { addNote(input.value); input.value = ''; }
      break;
    }
    case 'delete-note':        deleteNote(Number(el.dataset.index)); break;
    case 'set-winner':            setWinner(el.dataset.winner); break;
    case 'return-to-game-report': returnToGameFromReport(); break;
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
// 日志
// ══════════════════════════════════════════════════════════════════

/** 追加类型化事件。SPEC §3.4 / §16.1 */
function addLog(type, text, extra = {}) {
  const entry = {
    day: state.day, phase: state.phase, type,
    actor: null, targets: [], text, result: null, ts: Date.now(),
    ...extra,
  };
  update({ log: [...state.log, entry] });
  return entry;
}

/** 法官备注：底部输入框添加。空白内容不记录。SPEC §16.2 */
function addNote(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return;
  addLog('note', trimmed);
}

/** 删除备注。仅备注可删；先执行 + 撤销条。SPEC §8.2 / §16.2 */
function deleteNote(index) {
  const entry = state.log[index];
  if (!entry || entry.type !== 'note') return;
  const log = state.log.filter((_, i) => i !== index);
  update({ log });
  showUndoBar('已删除备注');
}

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

/** 注册 Service Worker。SPEC §13.2 */
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('./sw.js');
}

// ══════════════════════════════════════════════════════════════════
// 启动
// ══════════════════════════════════════════════════════════════════

function boot() {
  const saved = normalizeLoadedState(loadGame());
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
  timerTickHandle = setInterval(tickTimer, 250);
  render();
  registerServiceWorker();
}

boot();
