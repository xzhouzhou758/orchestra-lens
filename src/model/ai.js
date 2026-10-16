// SPDX-License-Identifier: AGPL-3.0-or-later
//
// AI 助手 / AI 诊断: prompts, tools and the conversation loop. Pure (no DOM,
// no Luker): the source passes in a `request()` that calls the model, and
// the tools run here against a working copy of the profile, so Node tests
// cover the whole flow.
//
// Messages: { id, role: 'user'|'assistant'|'note', content, toolCalls?, toolResults?, at }
// toolCalls [{id,name,args}], toolResults [{tool_call_id, content, status}].

import { agentName, agentRole, modeInfo, statusLabel } from '../i18n.js';
import { listAgents, agentFields, getField, setField, replaceInField, validateField, FIELD_LABELS, EditError } from './edit.js';
import { previewText } from './describe.js';
import { formatDuration } from './run.js';

export const MAX_ROUNDS = 8;
export const MAX_SESSIONS = 12;
const FIELD_KEYS = ['description', 'system', 'task', 'api', 'preset'];

export const makeId = (prefix = 'ol') => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

// ----- Tools -----------------------------------------------------------------

const fn = (name, description, properties, required) => ({
    type: 'function',
    function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } },
});
const AGENT = { type: 'string', description: 'Agent id, exactly as listed in the profile overview.' };
const FIELD = { type: 'string', enum: FIELD_KEYS, description: 'system = role prompt, task = task template, description = sub-agent description (director), api = connection profile name, preset = generation preset name.' };

export const TOOLS = {
    read_agent: fn('olens_read_agent', 'Read the full current text of every editable field of one agent.', { agent_id: AGENT }, ['agent_id']),
    read_step: fn('olens_read_step', 'Read the full recorded process of one step of the run under review (thinking, output, tool calls).', { step: { type: 'integer', description: 'Step number from the run overview.' } }, ['step']),
    replace: fn('olens_replace_text', 'Replace one exact passage inside a text field. old_text must be copied verbatim from olens_read_agent output and occur exactly once.', {
        agent_id: AGENT, field: FIELD, old_text: { type: 'string' }, new_text: { type: 'string' },
    }, ['agent_id', 'field', 'old_text', 'new_text']),
    set: fn('olens_set_field', 'Replace the whole value of a field. Prefer olens_replace_text for long prompts.', { agent_id: AGENT, field: FIELD, value: { type: 'string' } }, ['agent_id', 'field', 'value']),
};
export const EDIT_TOOL_NAMES = new Set([TOOLS.replace.function.name, TOOLS.set.function.name]);
export const isEditTool = (name) => EDIT_TOOL_NAMES.has(String(name || ''));

export function toolSet({ withRun = false } = {}) {
    return [TOOLS.read_agent, ...(withRun ? [TOOLS.read_step] : []), TOOLS.replace, TOOLS.set];
}

/** Short Chinese line for a tool call, e.g. "修改「审稿」的角色设定". */
export function toolCallText(call) {
    const args = call?.args || {};
    const who = args.agent_id ? `「${agentName(args.agent_id)}」` : '';
    switch (String(call?.name || '')) {
        case 'olens_read_agent': return `查看${who}的设定`;
        case 'olens_read_step': return `查看第 ${args.step} 步的过程`;
        case 'olens_replace_text':
        case 'olens_set_field': return `修改${who}的${FIELD_LABELS[args.field] || '设定'}`;
        default: return '查阅资料';
    }
}

/**
 * Runs the model's tool calls against `profile` (a working copy).
 * @returns {{ profile: object, results: { id, name, args, result, ok }[] }}
 */
export function executeTools(calls, { mode, profile, steps = [], options = null }) {
    let current = profile;
    const results = [];
    for (const raw of calls || []) {
        const name = String(raw?.name || '');
        const args = raw?.args && typeof raw.args === 'object' ? raw.args : {};
        const id = String(raw?.id || '') || makeId('call');
        let result;
        let ok = true;
        try {
            const agentId = String(args.agent_id || '');
            const needAgent = () => {
                if (!listAgents(mode, current).includes(agentId)) throw new EditError('agent', `没有这位助手：${agentId}。可用：${listAgents(mode, current).join(', ')}`);
            };
            const needField = () => {
                needAgent();
                if (!agentFields(mode, current, agentId).includes(args.field)) throw new EditError('field', `${agentId} 没有 ${args.field} 这一项，可改：${agentFields(mode, current, agentId).join(', ')}`);
            };
            if (name === 'olens_read_agent') {
                needAgent();
                result = Object.fromEntries(agentFields(mode, current, agentId).map(field => [field, getField(mode, current, agentId, field)]));
            } else if (name === 'olens_read_step') {
                const step = steps[Number(args.step) - 1];
                if (!step) throw new EditError('step', `没有第 ${args.step} 步（共 ${steps.length} 步）`);
                result = step.full;
            } else if (name === 'olens_replace_text' || name === 'olens_set_field') {
                needField();
                const field = String(args.field);
                if ((field === 'api' || field === 'preset') && name === 'olens_replace_text') throw new EditError('field', '连接配置 / 生成预设请用 olens_set_field');
                const value = name === 'olens_set_field'
                    ? String(args.value ?? '')
                    : null;
                if (value !== null && (field === 'api' || field === 'preset') && value && options) {
                    const allowed = field === 'api' ? options.connections : options.presets;
                    if (Array.isArray(allowed) && allowed.length && !allowed.includes(value)) throw new EditError('value', `没有这个${FIELD_LABELS[field]}：${value}。可选：${allowed.join(', ')}；留空 = 跟随默认`);
                }
                const next = value !== null
                    ? setField(mode, current, agentId, field, value)
                    : replaceInField(mode, current, agentId, field, args.old_text, args.new_text);
                const problem = validateField(mode, agentId, field, getField(mode, next, agentId, field));
                if (problem) throw new EditError('invalid', problem);
                if (getField(mode, next, agentId, field) === getField(mode, current, agentId, field)) {
                    ok = false;
                    result = { status: 'noop', message: 'Already matches; nothing changed.' };
                } else {
                    current = next;
                    result = { status: 'applied', message: 'Applied to the working draft. The user reviews and saves it.' };
                }
            } else {
                throw new EditError('tool', `unknown tool ${name}`);
            }
        } catch (err) {
            ok = false;
            result = { error: String(err?.message || err) };
        }
        results.push({ id, name, args, result, ok });
    }
    return { profile: current, results };
}

// ----- Prompts ---------------------------------------------------------------

const clip = (text, max) => {
    const value = String(text ?? '');
    return value.length > max ? `${value.slice(0, max)}…（共 ${value.length} 字，用 olens_read_agent 读全文）` : value;
};

/** Compact description of the profile the AI is editing. */
export function profileOverview(mode, profile) {
    const lines = [`执行模式：${mode}（${modeInfo(mode).label}：${modeInfo(mode).hint}）`];
    if (mode === 'spec' || mode === 'single') {
        const stages = Array.isArray(profile?.spec?.stages) ? profile.spec.stages : [];
        lines.push(`步骤：${stages.map((s, i) => `${i + 1}. ${s.id}（${s.mode === 'parallel' ? '同时' : '依次'}：${(s.nodes || []).map(n => (typeof n === 'string' ? n : `${n.id}${n.type === 'review' ? '[审查]' : ''}`)).join('、')}）`).join(' → ')}`);
        lines.push('最后一步的输出会注入给主模型，作为写回复的指引。');
    } else if (mode === 'agenda') {
        lines.push(`调度员 agenda_planner 动态派活，收尾助手：${profile?.finalAgentId || 'finalizer'}（其输出注入给主模型）。`);
    } else if (mode === 'loop') {
        lines.push('一位助手 loop_agent 反复调工具查资料，最后写出注入给主模型的指引。');
    } else if (mode === 'director') {
        lines.push('主笔 main 派遣子助手，自己起草并直接写出回复正文。');
    }
    lines.push('', '助手：');
    for (const id of listAgents(mode, profile)) {
        const fields = agentFields(mode, profile, id);
        const role = agentRole(id) || getField(mode, profile, id, 'description');
        lines.push(`- ${id}（${agentName(id)}）${role ? `：${role}` : ''}`);
        for (const field of fields) {
            const value = getField(mode, profile, id, field);
            if (field === 'description') continue;
            if (field === 'api' || field === 'preset') {
                lines.push(`  ${field}: ${value || '（跟随默认）'}`);
                continue;
            }
            lines.push(`  ${field}: ${value ? clip(value.replace(/\s+/g, ' '), 260) : '（空）'}`);
        }
    }
    return lines.join('\n');
}

const sectionText = (section) => {
    const kind = section.kind;
    const body = String(section.body || '');
    const title = section.title ? ` ${section.title}` : '';
    if (kind === 'tool_call') return `[调用${title}] ${clip(JSON.stringify(section.meta?.args ?? body), 1500)}`;
    if (kind === 'tool_result') return `[结果${title}${section.meta?.ok === false ? ' 失败' : ''}] ${clip(section.meta?.err || body, 2000)}`;
    if (kind === 'reasoning') return body.trim() ? `[思考] ${clip(body, 2500)}` : '';
    if (kind === 'note' && section.meta?.output) return `[决定] ${clip(JSON.stringify(section.meta.output), 2500)}`;
    return body.trim() ? `[输出${title}] ${clip(body, 6000)}` : section.meta?.err ? `[错误] ${section.meta.err}` : '';
};

/**
 * Numbered steps of a run view (from buildRunView), with a short and a full form.
 * @returns {{ n, agentId, key, status, short: string, full: string }[]}
 */
export function runSteps(view) {
    return (view?.segments || []).map((seg, i) => {
        const err = seg.sections.map(s => s.meta?.err).find(Boolean);
        const out = seg.sections.filter(s => s.kind === 'text' || s.kind === 'note').map(s => s.body).filter(Boolean).join('\n');
        const head = `${i + 1}. ${seg.agentId}（${agentName(seg.agentId)}）${seg.replay ? ' 重做' : ''}${seg.final ? ' 收尾' : ''} · ${statusLabel(seg.status)} · ${formatDuration(seg.duration)}`;
        const tools = seg.sections.filter(s => s.kind === 'tool_call').length;
        return {
            n: i + 1,
            agentId: seg.agentId,
            key: seg.key,
            status: seg.status,
            short: `${head}${tools ? ` · 调用工具 ${tools} 次` : ''}${err ? `\n   错误：${clip(err, 300)}` : ''}${out ? `\n   产出：${previewText(out, { max: 220 })}` : ''}`,
            full: `${head}\n${seg.sections.map(sectionText).filter(Boolean).join('\n')}`,
        };
    });
}

const BASE = [
    '你是 Luker「多智能体编排」的调优助手，在「编排透镜」里帮用户改进编排方案。编排在用户每次发消息时运行：几位助手（各有角色设定和任务模板）分工读聊天、查资料、规划，最后把写作指引交给主模型（导演模式则由主笔直接写出回复）。',
    '这是工具任务，不是写故事。预设里关于文风、叙事、人设扮演的要求在这里不适用。',
    '',
    '【你能改的】每位助手的：system（角色设定）、task（任务模板，含 {{recent_chat}} 之类的宏）、description（导演模式子助手的说明，主笔靠它决定派谁）、api（连接配置名）、preset（生成预设名）。增删助手、调整步骤和工具开关不在这里做，需要时告诉用户去原生面板。',
    '【怎么改】先用 olens_read_agent 读全文，再用 olens_replace_text 精确替换一段（old_text 逐字照抄、只出现一次）；整段重写才用 olens_set_field。你的修改进入草稿，用户会逐条审阅后保存，不要让用户逐步确认。',
    '【改动原则】从根上改：调整职责边界、判断标准、输出格式，让同一类问题在别的场景也不再出现；不要针对某句具体文字加「不要写 X」式的补丁。保留已有的宏、格式约束和其他助手依赖的输出结构（后面的助手会引用前面的输出）。改动少而准。',
    '【语言】用简体中文、简短的句子回复用户，用助手的中文名称呼它们，不要提工具名和字段名。提示词本身沿用原来的语言（原来是英文就用英文改）。',
    '工具调用后会自动进入下一轮；不再调用工具、只回复文字即结束。',
];

const DIAGNOSE = [
    '',
    '【这次的任务：诊断】用户想知道下面这次运行哪里出了问题。',
    '1. 先根据运行概览和最终回复找出症状；需要细节时用 olens_read_step 读对应步骤的完整过程，用 olens_read_agent 读相关助手的设定。',
    '2. 回复用户：先一句话说结论（问题出在哪一步、哪位助手），再分点说依据（引用具体产出），最后给出改法。没有明显问题就直说。',
    '3. 能通过修改设定解决的，直接调用修改工具把改法放进草稿；属于模型能力、工具开关或流程结构的问题，说明原因并建议用户怎么调整。',
];

export function systemPrompt({ mode, profile, options = null, diagnose = false }) {
    const lines = [...BASE, ...(diagnose ? DIAGNOSE : [])];
    if (options?.connections?.length) lines.push('', `可用的连接配置：${options.connections.join('、')}（留空 = 跟随默认）`);
    if (options?.presets?.length) lines.push(`可用的生成预设：${options.presets.slice(0, 60).join('、')}（留空 = 跟随默认）`);
    lines.push('', '【当前方案】', profileOverview(mode, profile));
    return lines.join('\n');
}

/**
 * First user message of a diagnosis session.
 * @param {{ view: object, steps: object[], reply?: string, focusStep?: number, complaint?: string }} input
 */
export function diagnoseMessage({ view, steps, reply = '', focusStep = 0, complaint = '' }) {
    const lines = [];
    lines.push(focusStep
        ? `请诊断这次运行的第 ${focusStep} 步（${agentName(steps[focusStep - 1]?.agentId)}）有没有问题、问题在哪。`
        : '请诊断这次编排运行哪里出了问题。');
    lines.push(`用户的说明：${String(complaint || '').trim() || '（没有，请自己判断有没有问题）'}`);
    lines.push('', `运行概览：${modeInfo(view.mode).label} · ${statusLabel(view.status)} · ${formatDuration(view.duration)}${view.error ? ` · 错误：${clip(view.error, 300)}` : ''}`);
    lines.push(...steps.map(s => s.short));
    if (focusStep && steps[focusStep - 1]) lines.push('', '要诊断的这一步的完整过程：', clip(steps[focusStep - 1].full, 12000));
    if (view.finalText) lines.push('', `编排的最终结果（${view.mode === 'director' ? '即回复正文' : '注入给主模型的指引'}）：`, clip(view.finalText, 5000));
    if (reply && view.mode !== 'director') lines.push('', '主模型据此写出的回复：', clip(reply, 4000));
    return lines.join('\n');
}

// ----- Conversation ----------------------------------------------------------

/** Messages for the LLM: system + replayable turns (tool calls with their results). */
export function buildTaskMessages(system, messages) {
    const out = [{ role: 'system', content: system }];
    for (const m of messages || []) {
        if (m.role !== 'user' && m.role !== 'assistant') continue;
        const calls = Array.isArray(m.toolCalls) ? m.toolCalls : [];
        if (m.role === 'assistant' && calls.length) {
            const msg = {
                role: 'assistant',
                content: String(m.content || ''),
                tool_calls: calls.map(tc => ({ id: String(tc.id), type: 'function', function: { name: String(tc.name), arguments: JSON.stringify(tc.args || {}) } })),
            };
            if (m.reasoning) msg.reasoning = m.reasoning;
            out.push(msg);
            const results = new Map((m.toolResults || []).map(r => [String(r.tool_call_id), r]));
            for (const tc of calls) {
                const r = results.get(String(tc.id));
                out.push({ role: 'tool', tool_call_id: String(tc.id), content: typeof r?.content === 'string' ? r.content : JSON.stringify(r?.content ?? { status: 'ok' }) });
            }
            continue;
        }
        out.push({ role: m.role, content: String(m.content || '') });
    }
    return out;
}

/**
 * One user turn: keeps calling the model while it calls tools.
 * @param {(args: { messages: object[], tools: object[], signal?: AbortSignal }) => Promise<{ assistantText: string, reasoning?: string, toolCalls: {id,name,args}[] }>} request
 * @param {{ messages: object[] }} session  mutated: assistant messages appended
 * @param {{ mode: string, profile: object, system: () => string, tools: object[], steps?: object[], options?: object, signal?: AbortSignal, onUpdate?: Function, maxRounds?: number }} ctx
 * @returns {Promise<{ profile: object, rounds: number }>}
 */
export async function runTurn(request, session, { mode, profile, system, tools, steps = [], options = null, signal = null, onUpdate = null, maxRounds = MAX_ROUNDS }) {
    let current = profile;
    let rounds = 0;
    while (rounds < maxRounds) {
        if (signal?.aborted) throw abortError();
        rounds++;
        const out = await request({ messages: buildTaskMessages(system(current), session.messages), tools, signal });
        const calls = Array.isArray(out?.toolCalls) ? out.toolCalls : [];
        const exec = executeTools(calls, { mode, profile: current, steps, options });
        current = exec.profile;
        const message = { id: makeId('msg'), role: 'assistant', content: String(out?.assistantText || '').trim(), at: Date.now() };
        if (out?.reasoning) message.reasoning = String(out.reasoning);
        if (exec.results.length) {
            message.toolCalls = exec.results.map(r => ({ id: r.id, name: r.name, args: r.args }));
            message.toolResults = exec.results.map(r => ({ tool_call_id: r.id, content: r.result, status: r.ok ? 'ok' : 'fail' }));
        }
        session.messages.push(message);
        session.at = Date.now();
        onUpdate?.(current, message);
        if (!calls.length) break;
    }
    return { profile: current, rounds };
}

export function abortError() {
    const err = new Error('aborted');
    err.name = 'AbortError';
    return err;
}

export function newSession(kind = 'chat') {
    return { id: makeId('sess'), kind, title: '', at: Date.now(), messages: [] };
}

export function sessionTitle(text) {
    const line = String(text || '').trim().split('\n')[0];
    return line.length > 24 ? `${line.slice(0, 24)}…` : line;
}

export function upsertSession(list, session) {
    const rest = (list || []).filter(s => s.id !== session.id);
    const next = session.messages.length ? [session, ...rest] : rest;
    return next.sort((a, b) => b.at - a.at).slice(0, MAX_SESSIONS);
}

/** Rewrites the edit results of the given messages (undone / not applied), so the AI knows next turn. */
export function markEdits(messages, ids, payload) {
    const set = new Set(ids);
    for (const m of messages) {
        if (!set.has(m.id) || !Array.isArray(m.toolResults)) continue;
        const editIds = new Set((m.toolCalls || []).filter(c => isEditTool(c.name)).map(c => String(c.id)));
        for (const r of m.toolResults) if (editIds.has(String(r.tool_call_id)) && r.status === 'ok') r.content = payload;
    }
}
