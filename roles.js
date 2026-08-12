/**
 * roles.js — 声明式角色数据表与夜晚步骤元数据
 * SPEC §3.1 / §4.1
 *
 * 本文件为纯数据，无逻辑。所有角色相关行为（技能消耗、死亡触发、
 * 信息计算）由 engine.js 依据这些声明派生，避免角色知识散落各处。
 */

/** 阵营 */
export const CAMP = {
  WOLF: 'wolf',
  GOD: 'god',
  CIV: 'civ',
};

/** 阵营显示名 */
export const CAMP_NAME = {
  [CAMP.WOLF]: '狼人阵营',
  [CAMP.GOD]: '神职角色',
  [CAMP.CIV]: '平民阵营',
};

/**
 * 19 个角色。情侣不在此列 —— 它是状态而非身份（SPEC §5.3）。
 *
 * @typedef {Object} Role
 * @property {string}   id
 * @property {string}   name
 * @property {string}   camp
 * @property {string}   icon         icons.svg 中的 symbol id
 * @property {?string}  nightStep    对应夜晚步骤 id；null = 无夜间行动
 * @property {string[]} skills       技能槽（SPEC §6）
 * @property {?string}  deathTrigger 死亡触发类型（SPEC §5.4）
 * @property {?string}  dayAction    白天主动行为
 */
export const ROLES = [
  // ── 狼人阵营 ────────────────────────────────────────────────────
  { id: 'wolf',          name: '普通狼人', camp: CAMP.WOLF, icon: 'icon-wolf',          nightStep: 'wolfkill', skills: [],              deathTrigger: null,       dayAction: 'selfDestruct' },
  { id: 'wolfking',      name: '狼王',     camp: CAMP.WOLF, icon: 'icon-wolfking',      nightStep: 'wolfkill', skills: ['shot'],        deathTrigger: 'shot',     dayAction: 'selfDestruct' },
  { id: 'whitewolfking', name: '白狼王',   camp: CAMP.WOLF, icon: 'icon-whitewolfking', nightStep: 'wolfkill', skills: ['selfDestruct'],deathTrigger: null,       dayAction: 'selfDestructWithTarget' },
  { id: 'wolfbeauty',    name: '狼美人',   camp: CAMP.WOLF, icon: 'icon-wolfbeauty',    nightStep: 'charm',    skills: ['charm'],       deathTrigger: 'charmLink',dayAction: 'selfDestruct' },
  { id: 'hiddenwolf',    name: '隐狼',     camp: CAMP.WOLF, icon: 'icon-hiddenwolf',    nightStep: null,       skills: [],              deathTrigger: null,       dayAction: null },
  { id: 'mechwolf',      name: '机械狼',   camp: CAMP.WOLF, icon: 'icon-mechwolf',      nightStep: 'mechwolf', skills: ['copy'],        deathTrigger: 'inherited',dayAction: 'selfDestruct' },

  // ── 神职角色 ────────────────────────────────────────────────────
  { id: 'seer',        name: '预言家',   camp: CAMP.GOD, icon: 'icon-seer',        nightStep: 'seer',        skills: [],                     deathTrigger: null,          dayAction: null },
  { id: 'witch',       name: '女巫',     camp: CAMP.GOD, icon: 'icon-witch',       nightStep: 'witch',       skills: ['antidote','poison'],  deathTrigger: null,          dayAction: null },
  { id: 'hunter',      name: '猎人',     camp: CAMP.GOD, icon: 'icon-hunter',      nightStep: null,          skills: ['shot'],               deathTrigger: 'shot',        dayAction: null },
  { id: 'guard',       name: '守卫',     camp: CAMP.GOD, icon: 'icon-guard',       nightStep: 'guard',       skills: ['lastTarget'],         deathTrigger: null,          dayAction: null },
  { id: 'idiot',       name: '白痴',     camp: CAMP.GOD, icon: 'icon-idiot',       nightStep: null,          skills: ['revealed'],           deathTrigger: 'idiotReveal', dayAction: null },
  { id: 'knight',      name: '骑士',     camp: CAMP.GOD, icon: 'icon-knight',      nightStep: null,          skills: ['duel'],               deathTrigger: null,          dayAction: 'duel' },
  { id: 'cupid',       name: '丘比特',   camp: CAMP.GOD, icon: 'icon-cupid',       nightStep: 'cupid',       skills: ['link'],               deathTrigger: null,          dayAction: null },
  { id: 'magician',    name: '魔术师',   camp: CAMP.GOD, icon: 'icon-magician',    nightStep: 'magician',    skills: ['swap'],               deathTrigger: null,          dayAction: null },
  { id: 'gravekeeper', name: '守墓人',   camp: CAMP.GOD, icon: 'icon-gravekeeper', nightStep: 'gravekeeper', skills: [],                     deathTrigger: null,          dayAction: null },
  { id: 'fox',         name: '狐狸',     camp: CAMP.GOD, icon: 'icon-fox',         nightStep: 'fox',         skills: ['active'],             deathTrigger: null,          dayAction: null },
  { id: 'bear',        name: '熊',       camp: CAMP.GOD, icon: 'icon-bear',        nightStep: 'bear',        skills: [],                     deathTrigger: null,          dayAction: null },
  { id: 'psychic',     name: '通灵师',   camp: CAMP.GOD, icon: 'icon-psychic',     nightStep: 'psychic',     skills: [],                     deathTrigger: null,          dayAction: null },

  // ── 平民阵营 ────────────────────────────────────────────────────
  { id: 'villager',    name: '平民',     camp: CAMP.CIV, icon: 'icon-villager',    nightStep: null,          skills: [],                     deathTrigger: null,          dayAction: null },
];

export const ROLE_MAP = Object.fromEntries(ROLES.map(r => [r.id, r]));
export const WOLF_ROLE_IDS = ROLES.filter(r => r.camp === CAMP.WOLF).map(r => r.id);

/**
 * 夜晚步骤元数据。
 * @typedef {Object} StepMeta
 * @property {string}  name           步骤显示名
 * @property {string}  instruction    法官口播提示语
 * @property {number}  targets        需点选的目标数；0 = 无需点选
 * @property {boolean} firstNightOnly 仅首夜执行
 * @property {?string} info           信息类步骤的答案种类（SPEC §9）
 */
export const STEP_META = {
  cupid:       { name: '丘比特',  instruction: '请丘比特连接两名玩家为情侣',                     targets: 2, firstNightOnly: true,  info: null },
  magician:    { name: '魔术师',  instruction: '请魔术师选择两名玩家，交换其今晚被使用技能的效果指向', targets: 2, firstNightOnly: false, info: null },
  guard:       { name: '守卫',    instruction: '请守卫选择今晚要守护的对象（可自守）',              targets: 1, firstNightOnly: false, info: null },
  wolfkill:    { name: '狼人',    instruction: '请狼人们共同选择今晚要击杀的目标',                 targets: 1, firstNightOnly: false, info: null },
  charm:       { name: '狼美人',  instruction: '请狼美人选择今晚要魅惑的对象',                    targets: 1, firstNightOnly: false, info: null },
  mechwolf:    { name: '机械狼',  instruction: '请机械狼选择复制一名玩家的身份与技能',             targets: 1, firstNightOnly: true,  info: null },
  witch:       { name: '女巫',    instruction: '请女巫决定是否使用解药 / 毒药',                   targets: 1, firstNightOnly: false, info: 'nightDeath' },
  seer:        { name: '预言家',  instruction: '请预言家选择一名玩家查验阵营',                    targets: 1, firstNightOnly: false, info: 'camp' },
  psychic:     { name: '通灵师',  instruction: '请通灵师选择一名玩家查验明确身份',                 targets: 1, firstNightOnly: false, info: 'exactRole' },
  fox:         { name: '狐狸',    instruction: '请狐狸选择起点，查验连续三名玩家中是否存在狼人',     targets: 1, firstNightOnly: false, info: 'foxCheck' },
  gravekeeper: { name: '守墓人',  instruction: '守墓人查验昨日被放逐者的身份',                    targets: 0, firstNightOnly: false, info: 'lastLynchedRole' },
  bear:        { name: '熊',      instruction: '判定熊是否咆哮（存活邻座是否有狼）',               targets: 0, firstNightOnly: false, info: 'bearGrowl' },
};

/** 默认夜晚顺序（SPEC §4.1 Step 3） */
export const DEFAULT_NIGHT_ORDER = [
  'cupid', 'magician', 'guard', 'wolfkill', 'charm', 'mechwolf',
  'witch', 'seer', 'psychic', 'fox', 'gravekeeper', 'bear',
];

/** 死因枚举（SPEC §5.2） */
export const DEATH_REASONS = [
  '被投票', '被狼杀', '被毒', '被枪', '被骑士处决',
  '殉情', '被魅惑', '自爆', '被自爆带走', '其他',
];

/** 会抑制开枪的「非常规死亡」死因（SPEC §5.4） */
export const ABNORMAL_DEATH_REASONS = ['被毒', '殉情'];

/** 预设局型（SPEC §4.1 Step 1） */
export const PRESETS = {
  9:  { playerCount: 9,  roleCounts: { wolf: 3, seer: 1, witch: 1, hunter: 1, villager: 3 } },
  12: { playerCount: 12, roleCounts: { wolf: 4, seer: 1, witch: 1, hunter: 1, guard: 1, villager: 4 } },
};

/** 默认规则开关（SPEC §7） */
export const DEFAULT_RULES = {
  doubleProtectKills: true,           // 同守同救 → 死亡
  witchSelfSave: 'firstNightOnly',    // 'never' | 'firstNightOnly' | 'always'
  guardRepeatAllowed: false,          // 禁止连守（仅警告，不阻断）
  abnormalDeathBlocksShot: true,      // 被毒 / 殉情 抑制开枪
  witchBothPotions: false,            // 同夜不可双药
};

/** 默认设置（SPEC §3.3） */
export const DEFAULT_SETTINGS = {
  soundEnabled: false,
  randomFirstSpeaker: true,
  theme: 'auto',
  dayTimerDefault: 180,
  nightTimerDefault: 60,
};
