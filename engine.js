/**
 * engine.js — 结算引擎
 * SPEC §5 / §9
 *
 * 全部为纯函数：输入 GameState，输出提案，不产生副作用、不改动入参。
 * 这是全项目最需要正确性保证的部分 —— 此处的 bug 会静默污染实时对局。
 * 所有导出函数须由 test.html 覆盖（SPEC §18）。
 *
 * ⚠️ 尚未实现 —— 仅为签名骨架。
 */

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
  throw new Error('未实现');
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
 *
 * @param {GameState} state
 * @param {Array<{seat:number, reason:string}>} deaths
 * @returns {Array<{seat:number, type:string, label:string}>}
 */
export function buildTriggerQueue(state, deaths) {
  throw new Error('未实现');
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
  throw new Error('未实现');
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
export function computeStepInfo(state, stepId, targets) {
  throw new Error('未实现');
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
  throw new Error('未实现');
}

/**
 * 校验夜晚行动是否违反规则开关，产出警告（不阻断）。SPEC §7 / §10.3
 * 涵盖：守卫连守、女巫自救、女巫同夜双药。
 *
 * @param {GameState} state
 * @param {string} stepId
 * @param {Object} action
 * @returns {Array<{type:string, text:string}>}
 */
export function validateAction(state, stepId, action) {
  throw new Error('未实现');
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
  throw new Error('未实现');
}

/**
 * 存活玩家的阵营计数（仅统计身份已知者）。SPEC §17
 * @param {GameState} state
 * @returns {{ wolf:number, god:number, civ:number, unknown:number }}
 */
export function campCounts(state) {
  throw new Error('未实现');
}

/**
 * 每日随机首发言：随机座位 + 方向。SPEC §15
 * 使用 crypto.getRandomValues。仅在存活玩家中抽取。
 *
 * @param {GameState} state
 * @returns {{ seat:number, direction:1|-1 }}
 */
export function pickFirstSpeaker(state) {
  throw new Error('未实现');
}

/**
 * 依方向取下一个存活座位（发言计时用）。SPEC §14.2
 * @param {GameState} state
 * @param {number} fromSeat
 * @param {1|-1} direction
 * @returns {?number}
 */
export function nextAliveSeat(state, fromSeat, direction) {
  throw new Error('未实现');
}
