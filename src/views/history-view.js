// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 历史: runs this browser recorded (with full process) plus the final
// results the orchestrator itself keeps per floor (no process).

import { h, clear, put, formatTime, truncate } from '../util.js';
import { icon } from '../icons.js';
import { t, statusLabel, modeInfo } from '../i18n.js';
import { buildRunView, displayStatus, formatDuration, formatTokens } from '../model/run.js';
import { emptyState, segmented, button } from '../ui/components.js';
import { agentAvatar } from './flow-view.js';

function dayLabel(ms) {
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) return '';
    const today = new Date();
    const same = (a, b) => a.toDateString() === b.toDateString();
    const yesterday = new Date(today.getTime() - 86400000);
    if (same(d, today)) return '今天';
    if (same(d, yesterday)) return '昨天';
    return `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
}

export function createHistoryView(app) {
    const el = h('section', { class: 'ol-history', 'aria-label': t('viewHistory') });
    let scope = 'chat';

    function runRow(raw) {
        const view = buildRunView(raw, []);
        const running = raw.status === 'running';
        const status = displayStatus(raw.status, raw.error);
        const agents = view.lanes.map(lane => lane.agentId);
        return h('button', {
            type: 'button',
            class: 'ol-hrow',
            dataset: { status: running ? 'running' : status },
            onClick: () => app.openRun(raw.runId),
        },
        h('span', { class: 'ol-hrow-time', text: raw.startedAtWall ? formatTime(raw.startedAtWall).slice(0, 5) : '' }),
        h('span', { class: 'ol-hrow-main' },
            h('span', { class: 'ol-hrow-top' },
                h('span', { class: 'ol-status', dataset: { status: running ? 'running' : status } }, h('span', { class: 'ol-status-dot', 'aria-hidden': 'true' }), h('span', { text: statusLabel(status) })),
                h('span', { class: 'ol-hrow-mode', text: modeInfo(raw.mode).label }),
                raw.floor > 0 ? h('span', { class: 'ol-hrow-floor', text: `#${raw.floor}` }) : null,
                scope === 'all' && raw.chatLabel ? h('span', { class: 'ol-hrow-chat', text: raw.chatLabel }) : null),
            raw.finalText ? h('span', { class: 'ol-hrow-text', text: truncate(String(raw.finalText).replace(/\s+/g, ' '), 140) }) : null),
        h('span', { class: 'ol-hrow-side' },
            h('span', { class: 'ol-hrow-avatars' }, agents.slice(0, 5).map(id => agentAvatar(id, { size: 'xs' })), agents.length > 5 ? h('span', { class: 'ol-hrow-more', text: `+${agents.length - 5}` }) : null),
            h('span', { class: 'ol-hrow-stats', text: [formatDuration(view.duration), view.tokens ? `${formatTokens(view.tokens)} tokens` : ''].filter(Boolean).join(' · ') })),
        icon('chevronRight', { size: 15, className: 'ol-hrow-go' }));
    }

    function anchorRow(anchor) {
        return h('button', {
            type: 'button',
            class: 'ol-hrow is-anchor',
            onClick: () => app.showText(`#${anchor.floor} · ${t('runFinal')}`, [
                { title: t('runFinal'), text: anchor.capsuleText },
                ...anchor.stageOutputs.filter(stage => stage?.nodes?.length).slice(0, -1).map(stage => ({
                    title: stage.id,
                    text: stage.nodes.map(node => `【${node.node}】\n${typeof node.output === 'string' ? node.output : JSON.stringify(node.output, null, 2)}`).join('\n\n'),
                })),
            ]),
        },
        h('span', { class: 'ol-hrow-time', text: `#${anchor.floor}` }),
        h('span', { class: 'ol-hrow-main' }, h('span', { class: 'ol-hrow-text', text: truncate(anchor.capsuleText.replace(/\s+/g, ' '), 160) })),
        icon('chevronRight', { size: 15, className: 'ol-hrow-go' }));
    }

    function render() {
        clear(el);
        const snapshot = app.snapshot();
        const chatId = snapshot?.chatId || '';
        const all = app.recorder.history();
        const items = scope === 'chat' && chatId ? all.filter(item => item.chatId === chatId) : all;
        const live = app.recorder.current();
        const showLive = live && live.status === 'running' && !live.quiet && !items.some(item => item.runId === live.runId) && (scope === 'all' || !chatId || live.chatId === chatId);
        const list = showLive ? [live, ...items] : items;

        put(el, h('div', { class: 'ol-history-head' },
            h('div', null,
                h('h2', { text: t('historyTitle') }),
                h('p', { class: 'ol-history-hint', text: t('historyHint') })),
            h('span', { class: 'ol-spacer' }),
            segmented([{ value: 'chat', label: t('thisChat') }, { value: 'all', label: t('allChats') }], scope, (value) => { scope = value; render(); }, { className: 'ol-seg-sm' }),
            items.length ? button(t('historyClear'), () => {
                if (!globalThis.confirm?.(t('historyClearConfirm'))) return;
                const ids = new Set(items.map(item => item.runId));
                app.recorder.removeWhere(item => ids.has(item.runId));
                render();
            }, { className: 'ol-btn-sm ol-btn-ghost', iconName: 'trash' }) : null));

        const body = h('div', { class: 'ol-history-body' });
        if (!list.length) put(body, emptyState('history', t('historyEmpty'), t('runNoneHint')));
        let lastDay = '';
        for (const raw of list) {
            const day = dayLabel(raw.startedAtWall);
            if (day && day !== lastDay) {
                put(body, h('div', { class: 'ol-hday', text: day }));
                lastDay = day;
            }
            put(body, runRow(raw));
        }

        const anchors = scope === 'chat' ? (snapshot?.anchors || []) : [];
        const recordedFloors = new Set(items.map(item => item.floor));
        const older = anchors.filter(anchor => !recordedFloors.has(anchor.floor));
        if (older.length) {
            put(body, h('div', { class: 'ol-hday is-anchors' },
                h('span', { text: t('historyAnchors') }),
                h('small', { text: t('historyAnchorsHint') })),
            older.slice(0, 50).map(anchorRow));
        }
        put(el, body);
    }

    return { id: 'history', el, render };
}
