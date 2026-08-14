/**
 * engine.js — 结算引擎
 * SPEC §5 / §9
 *
 * 全部为纯函数：输入 GameState，输出提案，不产生副作用、不改动入参。
 * 这是全项目最需要正确性保证的部分 —— 此处的 bug 会静默污染实时对局。
 * 所有导出函数须由 test.html 覆盖（SPEC §18）。
 *
 * ⚠️ 部分函数尚未实现 —— 结算相关函数仍为签名骨架。
 */

import { ROLE_MAP, STEP_META, CAMP, ABNORMAL_DEATH_REASONS } from './roles.js';

/**
 * 天亮结算。SPEC §5.1
 *
 * 处理顺序：
 *   1. 魔术师交换指向
 *   2. 狼刀
 *   3. 守卫守护抵消
 *   4. 女巫解药抵消
 *   5. 同守同救判定（依 rules.doubleProtectKills）
 *   6. 女巫毒药
 *   7. 情侣殉情
 *   8. 狼美人魅惑连锁
 *   9. 递归收敛（7、8 反复直至无新增；已处理座位集合去重防循环）
 *
 * @param {GameState} state
 * @returns {{ deaths: Array<{seat:number, reason:string, explanation:string}>,
 *             warnings: Array<{type:string, seat:number, text:string}> }}
 */
export function resolveDawn(state) {
  const actions = state.nightActions ?? {};
  const swap = actions.magicianSwap;
  const swapTarget = seat => {
    if (!swap || seat == null) return seat;
    const [a, b] = swap;
    if (seat === a) return b;
    if (seat === b) return a;
    return seat;
  };

  // 步骤 1 · 魔术师交换指向
  const wolfTarget = swapTarget(actions.wolfTarget ?? null);
  const guardTarget = swapTarget(actions.guardTarget ?? null);
  const witchAction = actions.witchAction ?? null;
  const witchTarget = witchAction && witchAction.type !== 'skip'
    ? swapTarget(witchAction.target ?? null)
    : null;
  const witchSaveTarget = witchAction?.type === 'save' ? witchTarget : null;
  const witchPoisonTarget = witchAction?.type === 'poison' ? witchTarget : null;

  const pending = new Map(); // seat -> { reason, explanation }
  const warnings = [];

  // 步骤 2–5 · 狼刀 + 守卫抵消 + 解药抵消 + 同守同救判定
  if (wolfTarget != null) {
    const guarded = guardTarget === wolfTarget;
    const saved = witchSaveTarget === wolfTarget;

    if (guarded && saved) {
      const killsAnyway = !!state.rules?.doubleProtectKills;
      warnings.push({
        type: 'doubleProtect',
        seat: wolfTarget,
        text: `${wolfTarget}号 同守同救：按当前规则${killsAnyway ? '仍死亡' : '不死亡'}`,
      });
      if (killsAnyway) {
        pending.set(wolfTarget, {
          reason: '被狼杀',
          explanation: `${wolfTarget}号 被狼杀（同守同救 · 按当前规则仍死亡）`,
        });
      }
    } else if (guarded) {
      // 撤销：被守卫守护
    } else if (saved) {
      // 撤销：被女巫解药
    } else {
      pending.set(wolfTarget, {
        reason: '被狼杀',
        explanation: `${wolfTarget}号 被狼杀（未被守护 · 未使用解药）`,
      });
    }
  }

  // 步骤 6 · 女巫毒药
  if (witchPoisonTarget != null) {
    pending.set(witchPoisonTarget, {
      reason: '被毒',
      explanation: `${witchPoisonTarget}号 被毒`,
    });
  }

  // 步骤 7–9 · 情侣殉情 + 狼美人魅惑连锁，递归收敛（已处理座位集合去重防循环）
  cascadeLoverAndCharm(state, pending);

  const deaths = [...pending.entries()]
    .sort(([a], [b]) => a - b)
    .map(([seat, { reason, explanation }]) => ({ seat, reason, explanation }));

  return { deaths, warnings };
}

/**
 * 情侣殉情 + 狼美人魅惑连锁的收敛逻辑（SPEC §5.1 步骤 7–9）。
 * 由 resolveDawn 与 cascadeDeaths 共用，避免连锁规则散落两处。
 * 就地扩充 `pending`（seat -> {reason, explanation}），已处理座位集合去重防循环。
 *
 * @param {GameState} state
 * @param {Map<number, {reason:string, explanation:string}>} pending
 */
function cascadeLoverAndCharm(state, pending) {
  const playersBySeat = new Map(state.players.map(p => [p.seat, p]));
  const processed = new Set();
  const queue = [...pending.keys()];

  while (queue.length > 0) {
    const seat = queue.shift();
    if (processed.has(seat)) continue;
    processed.add(seat);

    const player = playersBySeat.get(seat);
    if (!player) continue;

    // 白痴翻牌免死：该死亡会被判定为不死亡，不应向外连锁殉情 / 魅惑（SPEC §5.4）
    const role = ROLE_MAP[player.effectiveRoleId ?? player.roleId];
    const entry = pending.get(seat);
    const isIdiotSaved = role?.deathTrigger === 'idiotReveal' &&
      entry?.reason === '被投票' && !player.flags?.idiotRevealed;
    if (isIdiotSaved) continue;

    // 步骤 7 · 情侣殉情
    if (player.loverSeat != null) {
      const loverSeat = player.loverSeat;
      const lover = playersBySeat.get(loverSeat);
      if (lover && lover.alive && !pending.has(loverSeat)) {
        pending.set(loverSeat, {
          reason: '殉情',
          explanation: `${loverSeat}号 殉情（情侣 ${seat}号 死亡）`,
        });
        queue.push(loverSeat);
      }
    }

    // 步骤 8 · 狼美人魅惑连锁
    if (role?.id === 'wolfbeauty') {
      for (const p of state.players) {
        if (p.charmedBySeat === seat && p.alive && !pending.has(p.seat)) {
          pending.set(p.seat, {
            reason: '被魅惑',
            explanation: `${p.seat}号 被魅惑（狼美人 ${seat}号 死亡）`,
          });
          queue.push(p.seat);
        }
      }
    }
  }
}

/**
 * 由一组新增死亡计算死亡触发队列。SPEC §5.4
 *
 * 资格判定为死因感知：
 *   · shot（猎人 / 狼王）—— 死因属 ABNORMAL_DEATH_REASONS 且
 *     rules.abnormalDeathBlocksShot 为真时不入队
 *   · idiotReveal（白痴）—— 仅死因为「被投票」且未翻牌时触发；
 *     触发后不死亡，仅置 flags.idiotRevealed
 *   · charmLink（狼美人）—— 已于 resolveDawn 步骤 8 处理，不入队
 *
 * 白狼王自爆、骑士决斗、普通狼人自爆为白天主动行为，不属死亡触发。
 * 身份未知（roleId 与 effectiveRoleId 均为 null）的死者不产生任何触发。
 * 技能已消耗（skills.shot === false）的角色不再入队。
 *
 * @param {GameState} state
 * @param {Array<{seat:number, reason:string}>} deaths
 * @returns {Array<{seat:number, type:string, label:string}>}
 */
export function buildTriggerQueue(state, deaths) {
  const queue = [];

  for (const death of deaths) {
    const player = state.players.find(p => p.seat === death.seat);
    if (!player) continue;

    const roleId = player.effectiveRoleId ?? player.roleId;
    if (!roleId) continue; // 身份未知，优雅降级：不产生触发

    const role = ROLE_MAP[roleId];
    if (!role?.deathTrigger) continue;

    if (role.deathTrigger === 'shot') {
      if (player.skills?.shot === false) continue; // 技能已消耗

      const abnormal = ABNORMAL_DEATH_REASONS.includes(death.reason);
      if (abnormal && state.rules?.abnormalDeathBlocksShot) continue;

      queue.push({
        seat: death.seat,
        type: 'shot',
        label: `${death.seat}号（${role.name}）可开枪`,
      });
    } else if (role.deathTrigger === 'idiotReveal') {
      if (death.reason !== '被投票') continue;
      if (player.flags?.idiotRevealed) continue;

      queue.push({
        seat: death.seat,
        type: 'idiotReveal',
        label: `${death.seat}号（${role.name}）可翻牌免死`,
      });
    }
    // charmLink（狼美人）已于 resolveDawn 步骤 8 处理，不重复入队
  }

  return queue;
}

/**
 * 将触发 / 白天行为产生的死亡回流至殉情与魅惑连锁。SPEC §5.4
 * 复用 resolveDawn 的步骤 7–9，使连锁逐条呈现而无需法官心算。
 *
 * @param {GameState} state
 * @param {Array<{seat:number, reason:string}>} newDeaths
 * @returns {{ deaths: Array, warnings: Array }}
 */
export function cascadeDeaths(state, newDeaths) {
  const pending = new Map();
  for (const { seat, reason } of newDeaths) {
    pending.set(seat, { reason, explanation: `${seat}号 ${reason}` });
  }

  cascadeLoverAndCharm(state, pending);

  const deaths = [...pending.entries()]
    .sort(([a], [b]) => a - b)
    .map(([seat, { reason, explanation }]) => ({ seat, reason, explanation }));

  return { deaths, warnings: [] };
}

/**
 * 计算信息类步骤的答案。SPEC §9
 *
 * info 种类：
 *   'camp'            → '好人' | '狼人'（隐狼默认判为好人 / 金水）
 *   'exactRole'       → 角色名
 *   'lastLynchedRole' → 昨日被放逐者及其身份
 *   'nightDeath'      → 今晚狼刀目标（供女巫决定解药）
 *   'foxCheck'        → 连续三名存活玩家中是否存在狼人
 *   'bearGrowl'       → 见 bearGrowls()
 *
 * 目标身份未知时返回 { known: false }，界面降级为「请手动判断」，
 * 绝不给出错误结论。
 *
 * @param {GameState} state
 * @param {string} stepId
 * @param {number[]} targets
 * @returns {{ known: boolean, result?: string, detail?: string }}
 */
export function computeStepInfo(state, stepId, targets = []) {
  const meta = STEP_META[stepId];
  if (!meta?.info) return { known: false };

  switch (meta.info) {
    case 'camp': {
      const role = roleOfSeat(state, targets[0]);
      if (!role) return { known: false };
      // 隐狼不与狼队睁眼，预言家按房规默认将其查验为好人（SPEC §9）。
      const camp = role.id === 'hiddenwolf' || role.camp !== CAMP.WOLF ? '好人' : '狼人';
      return { known: true, result: camp };
    }

    case 'exactRole': {
      const role = roleOfSeat(state, targets[0]);
      if (!role) return { known: false };
      return { known: true, result: role.name };
    }

    case 'lastLynchedRole': {
      const lynched = state.players.find(p =>
        p.deathDay === state.day - 1 && p.deathPhase === 'day' && p.deathReason === '被投票');
      if (!lynched) return { known: false };
      const role = roleOfSeat(state, lynched.seat);
      if (!role) return { known: false };
      return { known: true, result: role.name, seat: lynched.seat };
    }

    case 'nightDeath': {
      const seat = state.nightActions.wolfTarget;
      if (seat == null) return { known: false };
      return { known: true, result: `${seat}号`, seat };
    }

    case 'foxCheck': {
      const start = targets[0];
      if (start == null) return { known: false };
      const chain = [start];
      let cur = start;
      for (let i = 0; i < 2; i++) {
        cur = nextAliveSeat(state, cur, 1);
        if (cur == null) return { known: false };
        chain.push(cur);
      }
      let anyUnknown = false;
      for (const seat of chain) {
        const role = roleOfSeat(state, seat);
        if (!role) { anyUnknown = true; continue; }
        if (role.camp === CAMP.WOLF) {
          return {
            known: true,
            result: '有狼人',
            hasWolf: true,
            disablesFox: false,
            chain,
          };
        }
      }
      if (anyUnknown) return { known: false };
      return {
        known: true,
        result: '无狼人',
        hasWolf: false,
        disablesFox: true,
        chain,
      };
    }

    case 'bearGrowl': {
      const growl = bearGrowls(state);
      if (growl === 'unknown') return { known: false };
      return { known: true, result: growl ? '应咆哮' : '不咆哮', growl };
    }

    default:
      return { known: false };
  }
}

function roleOfSeat(state, seat) {
  const p = state.players.find(p => p.seat === seat);
  if (!p) return null;
  const roleId = p.effectiveRoleId ?? p.roleId;
  return roleId ? ROLE_MAP[roleId] : null;
}

/**
 * 熊的咆哮判定。SPEC §5.5
 * 取熊左右两侧最近的存活座位（跨过死者），任一为狼阵营即咆哮。
 * 任一邻座身份未知时返回 'unknown'。
 *
 * @param {GameState} state
 * @returns {true | false | 'unknown'}
 */
export function bearGrowls(state) {
  const bear = state.players.find(p =>
    p.alive && ROLE_MAP[p.effectiveRoleId ?? p.roleId]?.nightStep === 'bear');
  if (!bear) return false;

  const left = nextAliveSeat(state, bear.seat, -1);
  const right = nextAliveSeat(state, bear.seat, 1);
  const neighbors = new Set([left, right].filter(s => s != null && s !== bear.seat));
  if (neighbors.size === 0) return false;

  let anyUnknown = false;
  for (const seat of neighbors) {
    const role = roleOfSeat(state, seat);
    if (!role) { anyUnknown = true; continue; }
    if (role.camp === CAMP.WOLF) return true;
  }
  return anyUnknown ? 'unknown' : false;
}

/**
 * 校验夜晚行动是否违反规则开关，产出警告（不阻断）。SPEC §7 / §10.3
 * 涵盖：守卫连守、女巫自救。
 *
 * @param {GameState} state
 * @param {string} stepId
 * @param {Object} action
 * @returns {Array<{type:string, text:string}>}
 */
export function validateAction(state, stepId, action) {
  const warnings = [];

  if (stepId === 'guard') {
    if (action.target != null && action.target === state.lastGuardTarget
        && !state.rules.guardRepeatAllowed) {
      warnings.push({
        type: 'guardRepeat',
        text: `守卫连续两晚守护 ${action.target}号，当前规则不允许连守`,
      });
    }
  }

  if (stepId === 'witch') {
    const witchSeat = findRoleActorSeat(state, 'witch');

    if (action.type === 'save' && witchSeat != null && action.target === witchSeat) {
      const mode = state.rules.witchSelfSave;
      if (mode === 'never' || (mode === 'firstNightOnly' && state.day !== 1)) {
        warnings.push({ type: 'witchSelfSave', text: '女巫自救不符合当前规则设置' });
      }
    }
  }

  return warnings;
}

function findRoleActorSeat(state, stepId) {
  const p = state.players.find(p =>
    p.alive && ROLE_MAP[p.effectiveRoleId ?? p.roleId]?.nightStep === stepId);
  return p ? p.seat : null;
}

/**
 * 当前局型下实际存在、且本夜应执行的步骤序列。SPEC §4.2 / §6
 * 过滤依据：角色是否在场、firstNightOnly、技能是否已耗尽
 * （女巫双药用尽、狐狸失效）。
 *
 * @param {GameState} state
 * @returns {string[]} stepId 序列
 */
export function activeNightSteps(state) {
  return state.nightOrder.filter(stepId => {
    const meta = STEP_META[stepId];
    if (!meta) return false;
    if (meta.firstNightOnly && state.day !== 1) return false;

    const actor = state.players.find(p => {
      if (!p.alive) return false;
      const role = ROLE_MAP[p.effectiveRoleId ?? p.roleId];
      return role?.nightStep === stepId;
    });
    if (!actor) return false;

    if (stepId === 'witch' && !actor.skills.antidote && !actor.skills.poison) return false;
    if (stepId === 'fox' && actor.flags.foxDisabled) return false;

    return true;
  });
}

/**
 * 存活玩家的阵营计数（仅统计身份已知者）。SPEC §17
 * @param {GameState} state
 * @returns {{ wolf:number, god:number, civ:number, unknown:number }}
 */
export function campCounts(state) {
  const counts = { wolf: 0, god: 0, civ: 0, unknown: 0 };
  for (const p of state.players) {
    if (!p.alive) continue;
    const roleId = p.effectiveRoleId ?? p.roleId;
    const role = roleId ? ROLE_MAP[roleId] : null;
    if (!role) {
      counts.unknown++;
    } else {
      counts[role.camp]++;
    }
  }
  return counts;
}

/**
 * 每日随机首发言：随机座位 + 方向。SPEC §15
 * 使用 crypto.getRandomValues。仅在存活玩家中抽取。
 *
 * @param {GameState} state
 * @returns {?{ seat:number, direction:1|-1 }}
 */
export function pickFirstSpeaker(state) {
  const aliveSeats = state.players.filter(p => p.alive).map(p => p.seat);
  if (aliveSeats.length === 0) return null;

  const seat = aliveSeats[randomIndex(aliveSeats.length)];
  const direction = randomIndex(2) === 0 ? 1 : -1;
  return { seat, direction };
}

function randomIndex(exclusiveMax) {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0] % exclusiveMax;
}

/**
 * 依方向取下一个存活座位（发言计时用）。SPEC §14.2
 * @param {GameState} state
 * @param {number} fromSeat
 * @param {1|-1} direction
 * @returns {?number}
 */
export function nextAliveSeat(state, fromSeat, direction) {
  const n = state.players.length;
  if (n === 0) return null;

  const wrap = seat => ((seat - 1) % n + n) % n + 1;

  for (let i = 1; i <= n; i++) {
    const seat = wrap(fromSeat + direction * i);
    const player = state.players.find(p => p.seat === seat);
    if (player && player.alive) return seat;
  }
  return null;
}
