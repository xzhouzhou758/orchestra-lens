// SPDX-License-Identifier: AGPL-3.0-or-later
//
// AI 助手 / AI 诊断 side panel. The AI edits its own copy of the profile
// (starting from the draft); each user turn ends with a field-level change
// list the user applies into the draft (or 自动应用). Nothing is saved until
// the topbar's 保存. A diagnosis session starts from one recorded run (or one
// step of it) and may end with proposed fixes the same way.

import { h, clear, put, formatTime } from '../util.js';
import { icon } from '../icons.js';
import { agentName } from '../i18n.js';
import { button, iconButton, checkRow, isTouch } from '../ui/components.js';
import { runTurn, newSession, sessionTitle, upsertSession, toolCallText, isEditTool, markEdits, makeId, toolSet, systemPrompt, runSteps, diagnoseMessage, statsMessage } from '../model/ai.js';
import { diffProfiles } from '../model/edit.js';
import { targetKey } from '../model/drafts.js';
import { changeList } from './change-list.js';

const SUGGESTIONS = [
    '检查各位助手的职责有没有重叠或遗漏',
    '让审查更严格地检查人物口吻',
    '把提示词改得更简洁，去掉重复的要求',
];
const ROLLED_BACK = { status: 'rolled_back', message: 'The user undid this edit; the working draft no longer contains it.' };
const DISCARDED = { status: 'rejected', message: 'The user did not apply this edit; the working draft does not contain it.' };
const AUTO_KEY = 'orchestraLens.aiAutoApply';

/**
 * @param {object} app  lens app (drafts, snapshot, recorder, notify, …)
 * @param {{ onClose(): void, openSettings(): void }} host
 */
export function createAiPanel(app, host) {
    const access = app.source.ai;
    const log = h('div', { class: 'ol-ai-log', role: 'log', 'aria-live': 'polite' });
    const context = h('div', { class: 'ol-ai-context', hidden: true });
    const input = h('textarea', {
        class: 'ol-ai-input',
        rows: 1,
        placeholder: '想怎么改编排？比如「让审稿别再打回小问题」',
        'aria-label': '给 AI 的要求',
        onInput: () => fit(),
        onKeydown: (event) => {
            event.stopPropagation();
            if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && !isTouch()) {
                event.preventDefault();
                send();
            }
        },
    });
    const sendBtn = h('button', { type: 'button', class: 'ol-ai-send', onClick: () => (busy ? stop() : send()) });
    const historyBox = h('div', { class: 'ol-ai-history', hidden: true });
    const titleEl = h('span', { class: 'ol-ai-title', text: 'AI 助手' });
    let autoApply = readAuto();
    const el = h('aside', { class: 'ol-ai', 'aria-label': 'AI 助手' },
        h('header', { class: 'ol-ai-head' },
            h('span', { class: 'ol-ai-mark', 'aria-hidden': 'true' }, icon('sparkle', { size: 15 })),
            titleEl,
            h('span', { class: 'ol-spacer' }),
            iconButton('gear', 'AI 使用的模型', () => host.openSettings(), { className: 'ol-iconbtn-sm' }),
            iconButton('clock', '对话记录', () => toggleHistory(), { className: 'ol-iconbtn-sm' }),
            iconButton('plus', '新对话', () => startNew(), { className: 'ol-iconbtn-sm' }),
            iconButton('x', '关闭', () => host.onClose(), { className: 'ol-iconbtn-sm' })),
        historyBox, context, log,
        h('div', { class: 'ol-ai-compose' }, input, sendBtn),
        h('div', { class: 'ol-ai-foot' },
            checkRow({
                checked: autoApply,
                label: '自动应用',
                note: 'AI 的修改直接放进草稿（仍需保存）',
                className: 'ol-ai-auto',
                onChange: (value) => {
                    autoApply = value;
                    try { localStorage.setItem(AUTO_KEY, value ? '1' : '0'); } catch { /* ignore */ }
                },
            }),
            isTouch() ? null : h('span', { class: 'ol-ai-keys', text: 'Enter 发送 · Shift+Enter 换行' })));

    let status = 'idle'; // idle | ready | unsupported
    let scope = '';
    let sessions = [];
    let session = newSession();
    let busy = false;
    let controller = null;
    let aiLive = null; // the AI's working copy (may be ahead of the draft)
    const turns = new Map(); // user msg id → turn
    let options = null;

    function fit() {
        input.style.height = 'auto';
        input.style.height = `${Math.min(input.scrollHeight + 2, 160)}px`;
    }

    const mode = () => app.drafts.target()?.mode || app.snapshot()?.mode || 'spec';
    const editable = () => app.canEdit();

    async function init() {
        try {
            await access.check();
            options = await app.source.edit?.options?.().catch(() => null) || null;
            status = 'ready';
        } catch {
            status = 'unsupported';
        }
        if (scope && status === 'ready') sessions = access.listSessions(scope);
        syncScope();
        paint();
    }

    /** Sessions are kept per preset (target). */
    function syncScope() {
        const key = targetKey(app.drafts.target() || app.snapshot()?.target);
        if (key === scope) return;
        const first = !scope; // first load: keep a session opened before data arrived
        scope = key;
        sessions = key && status === 'ready' ? access.listSessions(key) : [];
        if (!busy && !first) {
            session = newSession();
            turns.clear();
            aiLive = null;
        }
    }

    // ----- Diagnosis context ------------------------------------------------

    function runFor(key) {
        if (!key) return null;
        const raw = app.recorder.history().find(item => app.runKey(item) === key) || app.recorder.currents().find(item => app.runKey(item) === key);
        return raw || null;
    }

    function diagnosisContext() {
        if (session.kind !== 'diagnose') return null;
        const raw = runFor(session.runKey);
        if (!raw) return { missing: true };
        const view = app.runViewOf(raw);
        return { raw, view, steps: runSteps(view) };
    }

    const isDiag = () => session.kind === 'diagnose' || session.kind === 'stats';

    function paintContext() {
        clear(context);
        context.hidden = !isDiag();
        titleEl.textContent = isDiag() ? 'AI 诊断' : 'AI 助手';
        if (context.hidden) return;
        if (session.kind === 'stats') {
            const st = session.statsCtx;
            put(context, icon('timeline', { size: 13 }),
                h('span', { class: 'ol-ai-context-text', text: st ? `统计 · 最近 ${st.stats.runs} 次运行${st.focus ? ` · 「${agentName(st.focus)}」` : ''}` : '统计' }),
                button('查看', () => app.setState({ view: 'stats' }), { className: 'ol-btn-sm ol-btn-ghost' }));
            return;
        }
        const ctx = diagnosisContext();
        const raw = ctx?.raw;
        const step = session.step && ctx?.steps?.[session.step - 1];
        put(context,
            icon('target', { size: 13 }),
            h('span', { class: 'ol-ai-context-text', text: ctx?.missing ? '这次运行的记录已被清除' : `${raw?.startedAtWall ? formatTime(raw.startedAtWall).slice(0, 5) : ''} 那次运行${raw?.floor > 0 ? ` · #${raw.floor}` : ''}${step ? ` · 第 ${session.step} 步「${agentName(step.agentId)}」` : ''}` }),
            raw ? button('查看', () => app.openRun(session.runKey), { className: 'ol-btn-sm ol-btn-ghost' }) : null);
    }

    // ----- Rendering ----------------------------------------------------------

    // In a stats session the numbered items are evidence (E1…), not run steps.
    function readText(call) {
        if (session.kind === 'stats' && call.name === 'olens_read_step') {
            const e = session.statsCtx?.evidence?.[Number(call.args?.step) - 1];
            return e ? `查看「${agentName(e.agentId)}」${e.label}的过程` : `查看证据 E${call.args?.step}`;
        }
        return toolCallText(call);
    }

    function paintSend() {
        clear(sendBtn);
        sendBtn.setAttribute('aria-label', busy ? '停止' : '发送');
        sendBtn.title = busy ? '停止' : '发送';
        sendBtn.classList.toggle('is-busy', busy);
        put(sendBtn, icon(busy ? 'stop' : 'arrowUp', { size: 15 }));
        sendBtn.disabled = status !== 'ready';
        input.disabled = status !== 'ready';
        input.placeholder = isDiag() && !session.messages.length
            ? (session.kind === 'stats' ? '想重点看什么？（可以不写，直接发送）' : '哪里不满意？（可以不写，直接发送让 AI 自己找）')
            : isDiag() ? '继续追问，或让 AI 按诊断结果修改' : '想怎么改编排？比如「让审稿别再打回小问题」';
    }

    function paint() {
        paintSend();
        paintContext();
        clear(log);
        if (status === 'unsupported') {
            put(log, h('div', { class: 'ol-ai-empty' }, h('p', { text: '当前 Luker 版本不支持 AI 调用（缺少 iteration-library）。' })));
            return;
        }
        if (!editable()) {
            put(log, h('div', { class: 'ol-ai-note is-warn', text: app.editBlockedReason() || '当前方案不能在这里修改，AI 只能给建议。' }));
        }
        if (!session.messages.length) {
            if (session.kind === 'stats') {
                const st = session.statsCtx;
                put(log, h('div', { class: 'ol-ai-empty' },
                    h('p', { class: 'ol-ai-empty-title', text: st?.focus ? `诊断「${agentName(st.focus)}」` : '根据统计诊断' }),
                    h('p', { class: 'ol-ai-empty-sub', text: `AI 会看最近 ${st?.stats.runs || 0} 次运行的统计，再翻出${st?.focus ? '它' : '最慢、最常出错的助手'}出错和最慢的那几次过程，找出原因，能改的直接给出修改。` }),
                    h('div', { class: 'ol-ai-suggest' }, (st?.focus ? ['它为什么这么慢', '它为什么会出错', '给它换个更快的模型'] : ['想让整体快一些', '出错太多，看看为什么', '能不能给慢的助手换个快模型']).map(text => h('button', {
                        type: 'button', class: 'ol-ai-chip', onClick: () => { input.value = text; fit(); input.focus(); },
                    }, h('span', { text })))),
                    button('直接开始诊断', () => send({ allowEmpty: true }), { iconName: 'sparkle', className: 'ol-btn-sm ol-btn-primary' })));
                return;
            }
            if (session.kind === 'diagnose') {
                put(log, h('div', { class: 'ol-ai-empty' },
                    h('p', { class: 'ol-ai-empty-title', text: session.step ? '诊断这一步' : '诊断这次运行' }),
                    h('p', { class: 'ol-ai-empty-sub', text: 'AI 会读这次运行的每一步和最终结果，找出问题出在哪位助手、为什么，并提出修改建议。' }),
                    h('div', { class: 'ol-ai-suggest' }, ['回复太冷淡，没有人情味', '没有用上世界书的设定', '跑得太慢了'].map(text => h('button', {
                        type: 'button', class: 'ol-ai-chip', onClick: () => { input.value = text; fit(); input.focus(); },
                    }, h('span', { text })))),
                    button('直接开始诊断', () => send({ allowEmpty: true }), { iconName: 'sparkle', className: 'ol-btn-sm ol-btn-primary' })));
                return;
            }
            put(log, h('div', { class: 'ol-ai-empty' },
                h('p', { class: 'ol-ai-empty-title', text: '用说的来调整编排' }),
                h('p', { class: 'ol-ai-empty-sub', text: 'AI 会读当前方案，改各位助手的角色设定、任务模板和使用的模型。改动先列出来给你挑，保存后才生效。' }),
                h('div', { class: 'ol-ai-suggest' }, SUGGESTIONS.map(text => h('button', {
                    type: 'button', class: 'ol-ai-chip', onClick: () => { input.value = text; fit(); input.focus(); },
                }, h('span', { text }))))));
            return;
        }
        for (const m of session.messages) {
            if (m.role === 'user') {
                put(log, h('div', { class: 'ol-ai-msg is-user' }, h('div', { class: 'ol-ai-bubble', text: m.display ?? m.content })));
                continue;
            }
            if (m.role === 'note') {
                put(log, h('div', { class: 'ol-ai-note', text: m.content }));
                continue;
            }
            const calls = m.toolCalls || [];
            const results = new Map((m.toolResults || []).map(r => [String(r.tool_call_id), r]));
            const reads = calls.filter(c => !isEditTool(c.name));
            const edits = calls.filter(c => isEditTool(c.name));
            put(log, h('div', { class: 'ol-ai-msg is-ai' },
                reads.length ? h('div', { class: 'ol-ai-reads', text: reads.length === 1 ? readText(reads[0]) : `查阅了 ${reads.length} 处资料` }) : null,
                edits.length ? h('ul', { class: 'ol-ai-tools' }, edits.map(c => {
                    const r = results.get(String(c.id));
                    const noop = r?.content?.status === 'noop';
                    const failed = r?.status === 'fail' && !noop;
                    return h('li', { class: failed || noop ? 'is-fail' : '' }, icon(failed ? 'alert' : 'pen', { size: 12 }), h('span', { text: noop ? `${toolCallText(c)}（内容没变）` : failed ? `${toolCallText(c)}（没成功，AI 会重试）` : toolCallText(c) }));
                })) : null,
                m.content ? h('div', { class: 'ol-ai-text', text: m.content }) : null));
            const turn = [...turns.values()].find(x => x.endId === m.id);
            if (turn) put(log, turnCard(turn));
        }
        if (busy) put(log, h('div', { class: 'ol-ai-thinking' }, h('span', { class: 'ol-spinner', 'aria-hidden': 'true' }), h('span', { text: isDiag() ? '正在分析…' : '正在思考…' })));
        requestAnimationFrame(() => { log.scrollTop = log.scrollHeight; });
    }

    function turnCard(turn) {
        if (!turn.changes.length) return null;
        // A field the user changed by hand after the AI finished can't be applied blindly.
        const stale = new Set(turn.state === 'pending'
            ? turn.changes.filter(c => app.drafts.get(c.agentId, c.field) !== turn.draftAtEnd[c.id]).map(c => c.id)
            : []);
        return changeList({
            changes: turn.changes,
            state: editable() ? turn.state : 'review',
            applied: turn.applied,
            stale,
            onApply: (chosen) => applyTurn(turn, chosen),
            onDiscard: () => discardTurn(turn),
            onUndo: turn.state === 'applied' ? () => undoTurn(turn) : null,
            onFocus: (change) => app.focusField(change.agentId, change.field),
        });
    }

    // ----- Turns --------------------------------------------------------------

    function applyTurn(turn, chosen) {
        turn.before = app.drafts.applyMany(chosen.map(c => ({ agentId: c.agentId, field: c.field, after: c.after })), { by: 'ai' });
        turn.applied = new Set(chosen.map(c => c.id));
        turn.state = 'applied';
        if (chosen.length < turn.changes.length) {
            const skipped = turn.changes.filter(c => !turn.applied.has(c.id)).map(c => `${c.agentId}.${c.field}`);
            markEdits(session.messages, turn.ids, { status: 'partially_applied', message: `The user applied only some edits. Not applied: ${skipped.join(', ')}. Re-read before further edits.` });
            session.messages.push({ id: makeId('msg'), role: 'note', content: `应用了 ${chosen.length} / ${turn.changes.length} 处`, at: Date.now() });
        }
        aiLive = null;
        persist();
        paint();
    }

    function discardTurn(turn) {
        turn.state = 'discarded';
        markEdits(session.messages, turn.ids, DISCARDED);
        aiLive = null;
        persist();
        paint();
    }

    function undoTurn(turn) {
        const order = (x) => session.messages.findIndex(m => m.id === x.endId);
        const later = [...turns.values()].filter(x => x.state === 'applied' && order(x) > order(turn));
        for (const x of [turn, ...later]) x.state = 'undone';
        app.drafts.restore(turn.before);
        aiLive = null;
        markEdits(session.messages, [turn, ...later].flatMap(x => x.ids), ROLLED_BACK);
        session.messages.push({ id: makeId('msg'), role: 'note', content: later.length ? `已撤销最近 ${later.length + 1} 轮的修改` : '已撤销这一轮的修改', at: Date.now() });
        persist();
        paint();
    }

    async function send({ allowEmpty = false } = {}) {
        const text = input.value.trim();
        if ((!text && !(allowEmpty || (isDiag() && !session.messages.length))) || busy || status !== 'ready') return;
        syncScope();
        const diag = diagnosisContext();
        if (session.kind === 'diagnose' && diag?.missing) {
            app.notify('这次运行的记录已被清除，无法诊断', { error: true });
            return;
        }
        input.value = '';
        fit();
        const first = !session.messages.length;
        const userMsg = { id: makeId('msg'), role: 'user', content: text, at: Date.now() };
        if (session.kind === 'diagnose' && first) {
            userMsg.content = diagnoseMessage({ view: diag.view, steps: diag.steps, reply: access.replyFor?.(diag.raw) || '', focusStep: session.step || 0, complaint: text });
            userMsg.display = text ? `诊断：${text}` : (session.step ? '诊断这一步' : '诊断这次运行');
        }
        const st = session.statsCtx;
        if (session.kind === 'stats' && first) {
            userMsg.content = statsMessage({ stats: st.stats, evidence: st.evidence, mode: st.mode, focus: st.focus, complaint: text });
            userMsg.display = text ? `统计诊断：${text}` : (st.focus ? `诊断「${agentName(st.focus)}」` : '根据统计诊断');
        }
        if (first) {
            session.title = session.kind === 'stats' ? `统计诊断 · ${text || (st.focus ? agentName(st.focus) : '整体')}`
                : session.kind === 'diagnose' ? `诊断 · ${text || (session.step ? `第 ${session.step} 步` : '这次运行')}` : sessionTitle(text);
        }
        session.messages.push(userMsg);
        busy = true;
        controller = new AbortController();
        paint();
        const firstAi = session.messages.length;
        const pending = [...turns.values()].some(x => x.state === 'pending');
        const startCopy = pending && aiLive ? aiLive : app.drafts.profile();
        const m = mode();
        try {
            const out = await runTurn((args) => access.request(args), session, {
                mode: m,
                profile: startCopy,
                system: (live) => systemPrompt({ mode: m, profile: live, options, diagnose: session.kind === 'stats' ? 'stats' : session.kind === 'diagnose' }),
                tools: toolSet({ withRun: isDiag() }),
                steps: session.kind === 'stats' ? (st?.evidence || []) : (diag?.steps || []),
                options,
                signal: controller.signal,
                onUpdate: () => paint(),
            });
            aiLive = out.profile;
            const endId = session.messages[session.messages.length - 1]?.id;
            const ids = session.messages.slice(firstAi).map(x => x.id);
            const changes = diffProfiles(m, app.drafts.profile(), out.profile);
            for (const x of turns.values()) if (x.state === 'pending') x.state = 'superseded';
            if (changes.length) {
                const draftAtEnd = Object.fromEntries(changes.map(c => [c.id, app.drafts.get(c.agentId, c.field)]));
                const turn = { endId, ids, changes, state: 'pending', applied: new Set(), draftAtEnd, before: null };
                turns.set(userMsg.id, turn);
                if (autoApply && editable()) applyTurn(turn, changes);
            }
        } catch (err) {
            const aborted = err?.name === 'AbortError' || controller?.signal.aborted;
            session.messages.push({ id: makeId('msg'), role: 'note', content: aborted ? '已停止' : `AI 调用失败：${String(err?.message || err)}`, at: Date.now() });
        } finally {
            busy = false;
            controller = null;
            persist();
            paint();
        }
    }

    function stop() {
        controller?.abort();
    }

    function persist() {
        if (!scope) return;
        const stored = { ...session, messages: session.messages.filter(x => x.role !== 'note') };
        // Evidence bodies can be long; keep enough for a resumed chat to re-read.
        if (stored.statsCtx) stored.statsCtx = { ...stored.statsCtx, evidence: stored.statsCtx.evidence.map(e => ({ ...e, full: e.full.slice(0, 8000) })) };
        sessions = upsertSession(sessions, stored);
        try { access.saveSessions(scope, sessions); } catch { /* best effort */ }
    }

    function startNew(kind = 'chat', extra = {}) {
        if (busy) return false;
        session = { ...newSession(kind), ...extra };
        turns.clear();
        aiLive = null;
        historyBox.hidden = true;
        paint();
        input.focus();
        return true;
    }

    function toggleHistory() {
        historyBox.hidden = !historyBox.hidden;
        if (historyBox.hidden) return;
        clear(historyBox);
        if (!sessions.length) {
            put(historyBox, h('p', { class: 'ol-ai-history-empty', text: '这个方案还没有对话记录。' }));
            return;
        }
        put(historyBox, h('ul', null, sessions.map(s => h('li', null,
            h('button', {
                type: 'button',
                class: `ol-ai-history-item${s.id === session.id ? ' is-current' : ''}`,
                onClick: () => {
                    if (busy) return;
                    session = JSON.parse(JSON.stringify(s));
                    turns.clear();
                    aiLive = null;
                    historyBox.hidden = true;
                    paint();
                },
            },
            s.kind === 'stats' ? icon('timeline', { size: 12 }) : s.kind === 'diagnose' ? icon('target', { size: 12 }) : icon('sparkle', { size: 12 }),
            h('span', { class: 'ol-ai-history-title', text: s.title || '未命名对话' }),
            h('span', { class: 'ol-ai-history-meta', text: new Date(s.at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) })),
            iconButton('trash', '删除这条记录', () => {
                sessions = sessions.filter(x => x.id !== s.id);
                try { access.saveSessions(scope, sessions); } catch { /* ignore */ }
                if (s.id === session.id) startNew();
                else { historyBox.hidden = true; toggleHistory(); }
            }, { className: 'ol-iconbtn-sm' })))));
    }

    init();
    return {
        el,
        isBusy: () => busy,
        focus: () => requestAnimationFrame(() => input.focus()),
        /** Opens a chat with a prefilled request. */
        ask(text = '') {
            syncScope();
            if (isDiag() || session.messages.length > 6) startNew('chat');
            if (text) { input.value = text; fit(); }
            paint();
            requestAnimationFrame(() => { input.focus(); input.setSelectionRange(input.value.length, input.value.length); });
        },
        /** Starts a diagnosis session for one run (optionally one step). */
        diagnose(runKey, step = 0) {
            syncScope();
            if (!startNew('diagnose', { runKey, step: Number(step) || 0 })) app.notify('AI 正在回复，请稍候', { error: true });
        },
        /** Starts a diagnosis from the stats view. `ctx` = { stats, evidence, mode, focus }, frozen into the session. */
        diagnoseStats(ctx) {
            syncScope();
            if (!startNew('stats', { statsCtx: ctx })) app.notify('AI 正在回复，请稍候', { error: true });
        },
        /** Profile / target changed (reload, chat switch). */
        refresh() {
            syncScope();
            if (status === 'ready') paint();
        },
        destroy() { controller?.abort(); },
    };
}

function readAuto() {
    try { return localStorage.getItem(AUTO_KEY) === '1'; } catch { return false; }
}
