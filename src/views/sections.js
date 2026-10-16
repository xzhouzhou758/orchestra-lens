// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Renders the sections of one timeline segment (thinking, output, tool
// calls / results, planner decisions) as a readable step list. All text is
// model output → textContent only.

import { h, put, copyText, truncate } from '../util.js';
import { icon } from '../icons.js';
import { t, agentName, toolName } from '../i18n.js';
import { parseMaybeJson, toolNameOf, plannerDecision } from '../model/run.js';
import { iconButton } from '../ui/components.js';

const KIND = {
    reasoning: { label: 'kindReasoning', icon: 'brain' },
    text: { label: 'kindText', icon: 'doc' },
    tool_call: { label: 'kindToolCall', icon: 'tool' },
    tool_result: { label: 'kindToolResult', icon: 'check' },
    note: { label: 'kindNote', icon: 'review' },
    sub_agent: { label: 'kindSub', icon: 'user' },
};
const LONG = 700;

/** Collapsible text block; long text starts folded. */
function textBlock(text, { app, title = '', mono = false, collapsed = null } = {}) {
    const value = String(text ?? '');
    const long = value.length > LONG || value.split('\n').length > 14;
    const fold = collapsed ?? long;
    const pre = h('div', { class: `ol-textblock${mono ? ' is-mono' : ''}${fold ? ' is-folded' : ''}`, text: value });
    const more = long ? h('button', {
        type: 'button',
        class: 'ol-linkbtn ol-textblock-more',
        onClick: () => {
            const folded = pre.classList.toggle('is-folded');
            more.textContent = folded ? '展开全部' : '收起';
        },
        text: fold ? '展开全部' : '收起',
    }) : null;
    return h('div', { class: 'ol-textwrap' }, pre,
        h('div', { class: 'ol-textblock-foot' }, more,
            app && value.length > 200 ? h('button', { type: 'button', class: 'ol-linkbtn', text: '全屏查看', onClick: () => app.showText(title || t('kindText'), [{ title: '', text: value }]) }) : null));
}

/** Flat key/value list for small objects (tool args, results). */
function kvList(value) {
    if (!value || typeof value !== 'object') return null;
    const entries = Array.isArray(value) ? value.map((v, i) => [String(i + 1), v]) : Object.entries(value);
    if (!entries.length) return null;
    return h('dl', { class: 'ol-kv' }, entries.slice(0, 12).map(([key, raw]) => {
        const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
        return [h('dt', { text: key }), h('dd', { text: truncate(text, 400) })];
    }), entries.length > 12 ? h('dd', { class: 'ol-kv-more', text: `……还有 ${entries.length - 12} 项` }) : null);
}

function stepHead(kind, title, status, extra = null) {
    const meta = KIND[kind] || KIND.text;
    return h('div', { class: 'ol-step-head' },
        h('span', { class: 'ol-step-icon', 'aria-hidden': 'true' }, icon(meta.icon, { size: 13 })),
        h('span', { class: 'ol-step-kind', text: t(meta.label) }),
        title ? h('span', { class: 'ol-step-title', text: title }) : null,
        status === 'running' ? h('span', { class: 'ol-step-live' }, h('span', { class: 'ol-pulse' }), h('span', { text: t('running') })) : null,
        status === 'failed' ? h('span', { class: 'ol-step-fail', text: t('failed') }) : null,
        h('span', { class: 'ol-spacer' }),
        extra);
}

function copyBtn(app, text) {
    if (!text) return null;
    return iconButton('copy', t('copy'), async () => { if (await copyText(text)) app?.notify(t('copied')); }, { className: 'ol-iconbtn-sm' });
}

function plannerBlock(decision) {
    const parts = [];
    if (decision.todos.length) {
        parts.push(h('div', { class: 'ol-plan-group' },
            h('div', { class: 'ol-plan-label', text: t('planTodo') }),
            h('ul', { class: 'ol-plan-list' }, decision.todos.map(todo => h('li', { dataset: { op: todo.op } },
                h('span', { class: 'ol-plan-op', text: todo.op === 'add' ? '新增' : todo.op === 'drop' ? '放弃' : todo.status === 'done' ? '完成' : '更新' }),
                h('span', { text: todo.goal || todo.id }))))));
    }
    if (decision.dispatches.length) {
        parts.push(h('div', { class: 'ol-plan-group' },
            h('div', { class: 'ol-plan-label', text: t('planDispatch') }),
            h('ul', { class: 'ol-plan-list' }, decision.dispatches.map(d => h('li', null,
                h('span', { class: 'ol-plan-agent', text: agentName(d.agent) }),
                h('span', { text: d.brief }))))));
    }
    if (decision.finalize) parts.push(h('div', { class: 'ol-plan-final' }, icon('check', { size: 13 }), h('span', { text: t('planFinalize') })));
    return parts.length ? h('div', { class: 'ol-plan' }, parts) : null;
}

function toolCallBody(name, args) {
    const value = parseMaybeJson(args);
    if (name === 'dispatch_subagent' || name === 'dispatch_inline_subagent') {
        const id = value?.subagentId || value?.subagent_id || value?.agent || value?.id || '';
        const task = value?.task || value?.task_brief || value?.brief || '';
        return h('div', { class: 'ol-dispatch' },
            id ? h('span', { class: 'ol-plan-agent', text: agentName(id) }) : null,
            task ? h('span', { class: 'ol-dispatch-task', text: truncate(task, 600) }) : null);
    }
    if (typeof value === 'string') return value ? h('div', { class: 'ol-textblock is-mono', text: truncate(value, 1200) }) : null;
    return kvList(value);
}

export function renderSections(sections, { app, mode, agentId } = {}) {
    const list = h('ol', { class: 'ol-steps' });
    for (const section of sections || []) {
        const kind = section.kind;
        const body = String(section.body || '');
        let content = null;
        let title = '';
        let extra = copyBtn(app, body);
        if (kind === 'tool_call') {
            const name = toolNameOf(section);
            title = toolName(name);
            content = toolCallBody(name, section.meta?.args ?? body);
            extra = null;
        } else if (kind === 'tool_result') {
            const name = toolNameOf(section);
            const ok = section.meta?.ok !== false && section.status !== 'failed';
            title = `${toolName(name)} · ${ok ? t('ok') : t('failed')}`;
            const err = section.meta?.err;
            content = err ? h('div', { class: 'ol-step-err', text: String(err) }) : body ? textBlock(body, { app, mono: true, collapsed: true, title }) : null;
        } else if (kind === 'note' && section.meta?.output && mode === 'agenda') {
            const decision = plannerDecision(section);
            content = decision ? plannerBlock(decision) : textBlock(body, { app, mono: true });
        } else if (kind === 'reasoning') {
            if (!body.trim()) continue;
            content = textBlock(body, { app, collapsed: true, title: `${agentName(agentId)} · ${t('kindReasoning')}` });
        } else {
            if (section.meta?.err && !body) {
                content = h('div', { class: 'ol-step-err', text: String(section.meta.err) });
            } else if (body.trim()) {
                content = textBlock(body, { app, title: `${agentName(agentId)} · ${t('kindText')}` });
            } else if (section.status === 'running') {
                content = h('div', { class: 'ol-step-wait', text: '正在生成…' });
            } else if (kind === 'note') {
                content = h('div', { class: 'ol-step-wait', text: '审查结果已交给下一步' });
            } else {
                continue;
            }
        }
        put(list, h('li', { class: 'ol-step', dataset: { kind, status: section.status } },
            stepHead(kind, title, section.status, extra),
            content));
    }
    if (!list.firstChild) put(list, h('li', { class: 'ol-step is-empty', text: t('noOutput') }));
    return list;
}
