// SPDX-License-Identifier: AGPL-3.0-or-later
//
// UI strings and display names. Everything the user sees is Chinese; the
// orchestrator's internal ids (agent ids, tool names, statuses) are mapped
// here. Unknown agent ids are the user's own names and are shown as-is.
// Pure — safe to import in Node.

const STRINGS = {
    appName: '编排透镜', close: '关闭', refresh: '刷新', theme: '切换主题', inspector: '详情', toggleInspector: '详情栏',
    viewFlow: '流程', viewRun: '运行', viewHistory: '历史',
    enabled: '启用编排', disabledHint: '编排未启用，发消息时不会运行。', enableNow: '立即启用',
    mode: '执行模式', openNative: '在原生面板中编辑', openNativeUnavailable: '未找到多智能体编排面板（请确认已启用该扩展）',
    loading: '正在读取编排配置…', live: '实时', idle: '空闲', running: '运行中',
    errNoHost: '未检测到 Luker 运行环境。', errNoExtension: '未检测到多智能体编排插件，请确认已启用。', errApi: '无法读取编排数据（插件版本可能不兼容）。', errGeneric: '读取失败',
    scopeGlobal: '通用配置', scopeCharacter: '「{0}」专用', scopeChat: '本聊天专用', presetName: '方案「{0}」',

    // Flow
    flowStage: '第 {0} 步', flowParallel: '同时进行', flowSerial: '依次进行', flowReview: '审查',
    flowRerun: '不合格就打回重做', flowCapsule: '交给主模型写回复', flowFinalBody: '直接写出回复',
    flowStart: '开始', flowPlanner: '调度员', flowPool: '可派遣的助手', flowPoolHint: '调度员按需挑人派活，可同时派出多位',
    flowLoopTools: '可用工具', flowLoopHint: '同一位助手反复查资料，觉得够了就收尾',
    flowMain: '主笔', flowTeam: '助手团队 · 主笔按需派遣，可同时派出多位', flowMainHint: '统筹全局、起草正文、按反馈修改',
    groupScout: '起草前侦察', groupPlan: '构思', groupCritic: '起草后评审', groupCurator: '收尾整理', groupOther: '其他助手',
    nodeRuns: '运行 {0} 次', nodeFailed: '出错', nodeRunning: '正在工作', nodeDone: '已完成', nodeWaiting: '等待中',
    limits: '上限', limitRounds: '最多 {0} 轮', limitConcurrent: '同时最多 {0} 位', limitTotal: '总共最多 {0} 次', limitTime: '最长 {0} 秒',

    // Inspector
    role: '职责', description: '说明', systemPrompt: '角色设定（系统提示词）', userPrompt: '任务模板', model: '模型',
    apiPreset: '连接配置', promptPreset: '生成预设', followGlobal: '跟随编排默认', tools: '工具', noTools: '不使用工具', inheritTools: '沿用整体设置',
    lastOutput: '本次产出', noOutput: '本次还没有产出', copy: '复制', copied: '已复制', empty: '（空）',
    selectHint: '点选一位助手查看它的设定和本次产出。', overview: '概览', agents: '助手', stages: '步骤',

    // Run
    runNone: '还没有运行记录', runNoneHint: '编排会在你发送消息时自动运行，这里会实时显示过程。',
    runElapsed: '用时', runTokens: '消耗', runSteps: '步骤', runStatus: '状态', runFloor: '第 {0} 楼', runFinal: '最终结果',
    runCapsuleNote: '这段内容会注入给主模型', runBodyNote: '这段就是发出的回复正文', runStop: '停止',
    runTimeline: '时间线', runDetail: '过程', runPick: '点选时间线上的一段查看过程。',
    tokens: '{0} tokens', secs: '{0} 秒', mins: '{0} 分 {1} 秒',
    kindReasoning: '思考', kindText: '输出', kindToolCall: '调用', kindToolResult: '结果', kindNote: '决定', kindSub: '派遣',
    args: '参数', result: '返回', ok: '成功', failed: '失败', retry: '重试',
    planTodo: '待办', planDispatch: '派出', planFinalize: '准备收尾',
    viewing: '正在查看历史记录', backToLive: '回到当前',

    // History
    historyTitle: '运行记录', historyHint: '编排透镜会记下最近的运行过程（只存在本机浏览器）。',
    historyEmpty: '这个聊天还没有记录。', historyClear: '清空记录', historyClearConfirm: '清空这个聊天的运行记录？',
    historyAnchors: '更早的结果', historyAnchorsHint: '编排器自己保存的最终结果（没有过程）。',
    allChats: '所有聊天', thisChat: '当前聊天', simulated: '模拟',
};

const STATUS = {
    running: '运行中', committed: '完成', completed: '完成', reused: '复用', done: '完成',
    error: '出错', failed: '出错', aborted: '已停止', cancelled: '已取消', budget_exhausted: '超出预算',
};

const MODES = {
    spec: { label: '流水线', hint: '固定步骤，前一步做完才进入下一步' },
    single: { label: '单助手', hint: '一位助手一次做完，最快最省' },
    agenda: { label: '调度', hint: '调度员按情况动态派活' },
    loop: { label: '循环', hint: '一位助手反复查资料直到够用' },
    director: { label: '导演', hint: '主笔带领团队直接写出回复' },
    search: { label: '联网搜索', hint: '回复前先上网查资料' },
};

// Shipped default agents (spec presets, agenda agents, director sub-agents).
// User-created ids fall through to the raw id, which is their own name.
const AGENTS = {
    distiller: { name: '场景提炼', role: '读懂这一轮：用户想要什么、场面怎样、张力在哪' },
    lorebook_reader: { name: '世界书守门', role: '挑出这一轮必须遵守的世界书硬规则' },
    anti_data_guard: { name: '文风把关', role: '拦住报告腔、数据腔、播报腔的写法' },
    planner: { name: '剧情规划', role: '规划下一拍怎么推进，讲清因果' },
    recall_relevance: { name: '记忆筛选', role: '从召回的记忆里挑出这一轮真正用得上的' },
    critic: { name: '审稿', role: '逐项审查上一步的产出，不合格就点名打回' },
    synthesizer: { name: '汇总', role: '把通过的结果合成一段给主模型的写作指引' },
    finalizer: { name: '汇总', role: '把各位的成果合成一段给主模型的写作指引' },
    single_agent: { name: '单助手', role: '一次完成场景理解、规划和风险提示' },
    agenda_planner: { name: '调度员', role: '维护待办、派助手干活、判断何时收尾' },
    loop_agent: { name: '研究员', role: '自己查聊天、世界书、记忆，够了就写指引' },
    search_agent: { name: '搜索助手', role: '回复前先上网查资料，把有用的写进世界书' },
    main: { name: '主笔', role: '统筹全局、起草正文、按反馈修改并定稿' },
    intent_scout: { name: '意图侦察', role: '找出用户这一轮想要什么，以及世界书里的写作要求' },
    chat_scout: { name: '聊天侦察', role: '翻最近的聊天，找未了的情绪线和待回收的铺垫' },
    memory_scout: { name: '记忆侦察', role: '从记忆图里找和这一幕相关的事实' },
    lorebook_scout: { name: '世界书侦察', role: '查世界书里和这一幕相关的设定' },
    notes_pickup_scout: { name: '笔记侦察', role: '看看剧情笔记里有没有该在这一轮兑现的' },
    canon_scout: { name: '原作侦察', role: '查原作资料，避免和设定冲突' },
    epistemic_scout: { name: '认知边界', role: '核对每个角色知道什么、不该知道什么' },
    plot_brainstormer: { name: '情节构思', role: '给出几种结构草图供主笔挑选' },
    voice_critic: { name: '口吻评审', role: '揪出不像活人的描写和冷冰冰的数据腔' },
    continuity_critic: { name: '连贯评审', role: '找出和前文、记忆、世界书硬冲突的地方' },
    notes_curator: { name: '笔记整理', role: '更新剧情笔记（默认什么也不做）' },
    memory_curator: { name: '记忆整理', role: '把会延续的事实写进记忆图' },
};

const AGENT_GROUPS = {
    intent_scout: 'scout', chat_scout: 'scout', memory_scout: 'scout', lorebook_scout: 'scout',
    notes_pickup_scout: 'scout', canon_scout: 'scout', epistemic_scout: 'scout',
    plot_brainstormer: 'plan', voice_critic: 'critic', continuity_critic: 'critic',
    notes_curator: 'curator', memory_curator: 'curator',
};

const TOOLS = {
    chat_read_range: '翻看聊天', chat_search: '搜索聊天', draft_search: '搜索草稿', get_draft: '读取草稿',
    world_book_list: '列出世界书', lorebook_list: '列出世界书条目', lorebook_search: '搜索世界书', lorebook_get: '读取世界书条目',
    lorebook_force_activate: '强制启用世界书条目', note_open: '新建笔记', note_close: '关闭笔记', note_add: '记笔记',
    write_message: '写正文', apply_message_patches: '修改正文', finalize: '收尾',
    dispatch_subagent: '派遣助手', dispatch_inline_subagent: '派遣临时助手', await_subagents: '等待助手', cancel_subagent: '取消助手',
    skill_read: '查阅技能', skill_list: '列出技能',
    // Tool-flag keys from profiles (`<group>_<verb>`).
    chat_read: '翻看聊天', lorebook_world_book_list: '列出世界书', lorebook_force_activate: '强制启用世界书条目',
    message_write: '写正文', message_patch: '修改正文', message_read: '读取正文', message_get: '读取正文',
    collab_dispatch: '派遣助手', collab_await: '等待助手', collab_cancel: '取消助手', collab_inline: '派遣临时助手',
    luker_orch_review_approve: '审查通过', luker_orch_request_rerun: '打回重做',
    luker_orch_planner_step: '调度决定', luker_orch_submit_result: '提交结果',
};

const MEMORY_VERBS = { search: '搜索记忆', get: '读取记忆', recall: '召回记忆', list: '列出记忆', write: '写入记忆', edit: '修改记忆', upsert: '写入记忆' };

const TOOL_GROUPS = {
    chat: '聊天', lorebook: '世界书', note: '笔记', collab: '协作', message: '正文', custom: '扩展工具', finalize: '收尾',
};

const STAGE_NAMES = {
    distill: '提炼', grounding: '定规矩', reason: '规划', review: '审查', finalize: '汇总', single: '单助手', plan: '规划', final: '汇总',
};

export function t(key, ...args) {
    const template = STRINGS[key] ?? key;
    return args.length ? template.replace(/\{(\d+)\}/g, (_, i) => String(args[Number(i)] ?? '')) : template;
}

export const statusLabel = (status) => STATUS[status] || STATUS.done;
export const modeInfo = (mode) => MODES[mode] || MODES.spec;
export const MODE_IDS = Object.keys(MODES).filter(id => id !== 'search');

/** Display name for an agent id. Unknown ids are user-defined names: keep them. */
export function agentName(id) {
    const key = String(id || '');
    return AGENTS[key]?.name || humanizeId(key);
}
export const agentRole = (id) => AGENTS[String(id || '')]?.role || '';
export const agentGroup = (id) => AGENT_GROUPS[String(id || '')] || 'other';
export const isKnownAgent = (id) => Object.prototype.hasOwnProperty.call(AGENTS, String(id || ''));

export function toolName(name) {
    const key = String(name || '');
    if (TOOLS[key]) return TOOLS[key];
    if (key.startsWith('memory_')) return MEMORY_VERBS[key.slice(7)] || '记忆图工具';
    if (key.startsWith('search_')) return key === 'search_visit' ? '打开网页' : '联网搜索';
    const group = key.split('_')[0];
    if (TOOL_GROUPS[group] && group !== key) return `${TOOL_GROUPS[group]}工具`;
    if (key.startsWith('mg_')) return '记忆图工具';
    return humanizeId(key) || '工具';
}
export const toolGroupName = (group) => TOOL_GROUPS[group] || humanizeId(group);

export function stageName(id) {
    const key = String(id || '');
    return STAGE_NAMES[key] || humanizeId(key);
}

/** "lorebook_reader" → "lorebook reader"; keeps Chinese ids untouched. */
export function humanizeId(id) {
    return String(id || '').replace(/[_-]+/g, ' ').trim();
}
