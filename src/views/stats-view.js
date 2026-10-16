// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 统计: per-agent duration and failure figures over the runs this browser
// recorded. Tokens are only known per run, so they are shown per run.

import { h, clear, put } from '../util.js';
import { icon } from '../icons.js';
import { t, agentName, modeInfo } from '../i18n.js';
import { agentStats } from '../model/stats.js';
import { formatDuration, formatTokens } from '../model/run.js';
import { emptyState, segmented } from '../ui/components.js';
import { agentAvatar, toneOf } from './flow-view.js';

export function createStatsView(app) {
    const el = h('section', { class: 'ol-stats-view', 'aria-label': '统计' });
    let scope = 'chat';
    let source = 'orchestrator';

    function card(label, value, note = '') {
        return h('div', { class: 'ol-scard' },
            h('span', { class: 'ol-stat-label', text: label }),
            h('span', { class: 'ol-scard-value', text: value }),
            note ? h('span', { class: 'ol-scard-note', text: note }) : null);
    }

    function render() {
        clear(el);
        const chatId = app.snapshot()?.chatId || '';
        const all = app.recorder.history();
        // Agents differ per execution mode: count only runs of the mode on screen.
        const mode = app.snapshot()?.mode || '';
        const sameMode = (r) => source === 'search' || !mode || r.mode === mode || (mode === 'single' && r.mode === 'spec');
        const runs = (scope === 'chat' && chatId ? all.filter(r => r.chatId === chatId) : all).filter(sameMode);
        const stats = agentStats(runs, { knownIds: Object.keys(app.flow()?.agents || {}), source });
        put(el, h('div', { class: 'ol-history-head' },
            h('div', null,
                h('h2', { text: '统计' }),
                h('p', { class: 'ol-history-hint', text: `根据本机记下的最近运行计算${source === 'orchestrator' && mode ? `（只算「${modeInfo(mode).label}」模式）` : ''}。找出最慢、最常出错的助手，考虑给它换更快的模型或精简提示词。` })),
            h('span', { class: 'ol-spacer' }),
            segmented([{ value: 'orchestrator', label: '编排' }, { value: 'search', label: '联网搜索' }], source, (value) => { source = value; render(); }, { className: 'ol-seg-sm' }),
            segmented([{ value: 'chat', label: t('thisChat') }, { value: 'all', label: t('allChats') }], scope, (value) => { scope = value; render(); }, { className: 'ol-seg-sm' })));
        const body = h('div', { class: 'ol-stats-body' });
        put(el, body);
        if (!stats.runs) {
            put(body, emptyState('history', '还没有可统计的运行', '运行几次编排后再来看。'));
            return;
        }
        const failRate = stats.failedRuns / stats.runs;
        put(body, h('div', { class: 'ol-scards' },
            card('运行次数', String(stats.runs)),
            card('平均用时', formatDuration(stats.avgDuration)),
            card('出错', stats.failedRuns ? `${stats.failedRuns} 次` : '没有', stats.failedRuns ? `${Math.round(failRate * 100)}%` : ''),
            stats.avgTokens ? card('每次消耗', `${formatTokens(Math.round(stats.avgTokens))}`, 'tokens · 平均') : null));

        const slowest = stats.agents.reduce((a, b) => (b.avg > (a?.avg ?? -1) ? b : a), null);
        const worst = stats.agents.filter(a => a.failed).sort((a, b) => b.failRate - a.failRate)[0];
        const maxAvg = Math.max(1, ...stats.agents.map(a => a.avg));
        put(body,
            h('div', { class: 'ol-stable', role: 'table', 'aria-label': '每位助手' },
                h('div', { class: 'ol-srow is-head', role: 'row' },
                    h('span', { role: 'columnheader', text: '助手' }),
                    h('span', { role: 'columnheader', text: '平均用时' }),
                    h('span', { role: 'columnheader', class: 'ol-scol-num', text: '最长' }),
                    h('span', { role: 'columnheader', class: 'ol-scol-num', text: '出现' }),
                    h('span', { role: 'columnheader', class: 'ol-scol-num', text: '出错' }),
                    h('span', { role: 'columnheader', class: 'ol-scol-num', title: '占所有助手工作时间的比例（同时进行的都算）', text: '占时' })),
                stats.agents.map(a => h('button', {
                    type: 'button',
                    class: 'ol-srow',
                    role: 'row',
                    dataset: { tone: toneOf(a.agentId) },
                    title: a.lastError ? `最近一次出错：${a.lastError}` : null,
                    onClick: () => { app.setState({ view: 'flow' }); app.selectAgent(a.agentId); },
                },
                h('span', { class: 'ol-scol-agent', role: 'cell' },
                    agentAvatar(a.agentId, { size: 'sm' }),
                    h('span', { class: 'ol-lane-name', text: agentName(a.agentId) }),
                    a === slowest && stats.agents.length > 1 ? h('span', { class: 'ol-stag is-slow', text: '最慢' }) : null,
                    a === worst ? h('span', { class: 'ol-stag is-bad', text: '最常出错' }) : null),
                h('span', { class: 'ol-scol-bar', role: 'cell' },
                    h('span', { class: 'ol-sbar' }, h('span', { style: { width: `${Math.max(2, (a.avg / maxAvg) * 100)}%` } })),
                    h('span', { class: 'ol-sbar-text', text: formatDuration(a.avg) })),
                h('span', { class: 'ol-scol-num', role: 'cell', text: formatDuration(a.max) }),
                h('span', { class: 'ol-scol-num', role: 'cell', text: a.steps > a.runs ? `${a.runs} 次 · ${a.steps} 段` : `${a.runs} 次` }),
                h('span', { class: `ol-scol-num${a.failed ? ' is-bad' : ''}`, role: 'cell', text: a.failed ? `${a.failed}（${Math.round(a.failRate * 100)}%）` : '—' }),
                h('span', { class: 'ol-scol-num', role: 'cell', text: `${Math.round(a.share * 100)}%` })))),
            h('p', { class: 'ol-stats-note' }, icon('alert', { size: 12 }), h('span', { text: '消耗的 tokens 只按整次运行记录，没法分到每位助手。点一行可以查看并修改这位助手的设定。' })));
    }

    return { id: 'stats', el, render };
}
