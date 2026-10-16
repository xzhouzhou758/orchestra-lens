// SPDX-License-Identifier: AGPL-3.0-or-later
//
// One-line, plain-Chinese descriptions of what an agent is doing, for the
// side panel ("搜索网页「雾港 灯塔」", "派遣 聊天侦察"). Pure: no DOM.

import { truncate } from '../util.js';
import { agentName, toolName } from '../i18n.js';
import { parseMaybeJson, toolNameOf, plannerDecision } from './run.js';

const quote = (value, max = 36) => `「${truncate(String(value ?? '').replace(/\s+/g, ' ').trim(), max)}」`;
const count = (value) => (Array.isArray(value) ? value.length : value ? 1 : 0);

function hostOf(url) {
    try { return new URL(String(url)).hostname.replace(/^www\./, ''); } catch { return truncate(String(url || ''), 40); }
}

/** @returns {{ icon: string, text: string }} */
export function describeToolCall(name, rawArgs) {
    const args = parseMaybeJson(rawArgs);
    const a = args && typeof args === 'object' ? args : {};
    const n = String(name || '');
    const q = a.query ?? a.q ?? a.keyword ?? a.keywords;
    if (/(^|_)(web_search|agent_search)$/.test(n) || n === 'search_search') return { icon: 'search', text: q ? `搜索网页${quote(q)}` : '搜索网页' };
    if (/(^|_)(web_visit|agent_visit)$/.test(n) || n === 'search_visit') return { icon: 'external', text: a.url ? `打开 ${hostOf(a.url)}` : '打开网页' };
    if (/upsert_lorebook_entry$/.test(n)) return { icon: 'pen', text: a.title ? `写入世界书${quote(a.title)}` : '写入世界书条目' };
    if (/delete_lorebook_entry$/.test(n)) return { icon: 'trash', text: `删除 ${count(a.entry_ids)} 条世界书条目` };
    if (/get_lorebook_entries$/.test(n)) return { icon: 'doc', text: `读取 ${count(a.entry_ids)} 条世界书条目` };
    switch (n) {
        case 'chat_search': return { icon: 'search', text: q ? `搜索聊天${quote(q)}` : '搜索聊天' };
        case 'chat_read_range': return { icon: 'doc', text: a.from != null && a.to != null ? `翻看第 ${a.from}–${a.to} 楼` : '翻看聊天' };
        case 'lorebook_search': return { icon: 'search', text: q ? `搜索世界书${quote(q)}` : '搜索世界书' };
        case 'lorebook_get': return { icon: 'doc', text: '读取世界书条目' };
        case 'dispatch_subagent':
        case 'dispatch_inline_subagent': {
            const id = a.subagentId || a.subagent_id || a.agent || '';
            return { icon: 'user', text: id ? `派遣 ${agentName(id)}` : '派遣临时助手' };
        }
        case 'await_subagents': return { icon: 'clock', text: count(a.handles) > 1 ? `等待 ${count(a.handles)} 位助手` : '等待助手' };
        case 'write_message': return { icon: 'pen', text: a.text ? `写正文（${String(a.text).length} 字）` : '写正文' };
        case 'apply_message_patches': return { icon: 'pen', text: count(a.patches) ? `修改正文 ${count(a.patches)} 处` : '修改正文' };
        case 'finalize': return { icon: 'check', text: '收尾' };
        case 'luker_orch_review_approve': return { icon: 'check', text: '审查通过' };
        case 'luker_orch_request_rerun': return { icon: 'repeat', text: '打回重做' };
        default:
            if (n.startsWith('memory_')) return { icon: 'search', text: q ? `${toolName(n)}${quote(q)}` : toolName(n) };
            return { icon: 'tool', text: toolName(n) };
    }
}

/**
 * Short readable excerpt of model output. YAML-ish "key: value" lines keep
 * the value; bullet markers are dropped. `tail` shows the end (streaming).
 */
export function previewText(body, { tail = false, max = 120 } = {}) {
    const lines = String(body ?? '')
        .split('\n')
        .map(line => line.trim().replace(/^[-*•]\s+/, '').replace(/^[A-Za-z_][\w-]*:\s*/, '').replace(/^["']|["']$/g, '').trim())
        .filter(line => line && !/^[[\]{}]+,?$/.test(line));
    if (!lines.length) return '';
    const text = (tail ? lines.slice(-3) : lines.slice(0, 3)).join(' · ');
    if (text.length <= max) return text;
    return tail ? `…${text.slice(-(max - 1))}` : truncate(text, max);
}

/**
 * What to show under an agent's row.
 * @returns {{ lines: {icon: string, text: string, muted?: boolean}[] }}
 */
export function segmentPreview(seg, mode) {
    const lines = [];
    if (!seg || seg.pending) return { lines: [{ icon: 'clock', text: '等待中', muted: true }] };
    const running = seg.status === 'running';
    const sections = seg.sections || [];

    if (mode === 'agenda') {
        const decision = plannerDecision(sections.find(s => s.meta?.output));
        if (decision) {
            if (decision.dispatches.length) lines.push({ icon: 'user', text: `派出 ${decision.dispatches.map(d => agentName(d.agent)).join('、')}` });
            const added = decision.todos.filter(op => op.op === 'add').length;
            if (added) lines.push({ icon: 'plus', text: `新增 ${added} 项待办` });
            if (decision.finalize) lines.push({ icon: 'check', text: '准备收尾' });
            return { lines };
        }
    }

    for (const section of sections) {
        if (section.kind !== 'tool_call') continue;
        const name = toolNameOf(section);
        const result = sections.find(s => s.kind === 'tool_result' && s.id === section.id.replace(/^tool-/, 'tool-result-'));
        const line = describeToolCall(name, section.meta?.args ?? section.body);
        if (result && (result.meta?.ok === false || result.status === 'failed')) line.text += '（失败）';
        lines.push(line);
    }

    const text = sections.filter(s => s.kind === 'text' || s.kind === 'note').map(s => s.body).join('\n');
    const excerpt = previewText(text, { tail: running });
    // Director drafts go out through write_message; its text section is chatter.
    if (excerpt && (!lines.length || !running)) lines.unshift({ icon: 'doc', text: excerpt, quote: true });

    if (!lines.length) {
        const reasoning = sections.find(s => s.kind === 'reasoning')?.body;
        if (running) lines.push({ icon: 'brain', text: reasoning ? `思考中 · ${previewText(reasoning, { tail: true, max: 90 })}` : '正在工作…', muted: true });
        else if (sections.some(s => s.kind === 'note')) lines.push({ icon: 'review', text: '审查结果已交给下一步', muted: true });
        else if (seg.status === 'failed') lines.push({ icon: 'alert', text: String(sections.find(s => s.meta?.err)?.meta?.err || '出错了') });
    }
    return { lines };
}
