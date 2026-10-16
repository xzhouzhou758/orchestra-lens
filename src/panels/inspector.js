// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Right-hand detail panel for the selected agent: what it does, its prompts,
// model routing and tools, and what it produced in the current run.

import { h, clear, put, copyText } from '../util.js';
import { icon } from '../icons.js';
import { t, agentName, agentRole, toolName, modeInfo, statusLabel } from '../i18n.js';
import { formatDuration } from '../model/run.js';
import { iconButton, emptyState } from '../ui/components.js';
import { agentAvatar, toneOf } from '../views/flow-view.js';
import { renderSections } from '../views/sections.js';

const PROMPT_PREVIEW = 420;

export function createInspector(app) {
    const bodyEl = h('div', { class: 'ol-insp-body' });
    const el = h('aside', { class: 'ol-inspector', 'aria-label': t('inspector') }, bodyEl);

    function promptBlock(title, text) {
        const value = String(text || '').trim();
        if (!value) return null;
        const long = value.length > PROMPT_PREVIEW;
        return h('section', { class: 'ol-insp-section' },
            h('div', { class: 'ol-section-title' }, h('span', { text: title }),
                h('span', { class: 'ol-insp-actions' },
                    iconButton('copy', t('copy'), async () => { if (await copyText(value)) app.notify(t('copied')); }, { className: 'ol-iconbtn-sm' }),
                    long ? iconButton('fit', '全屏查看', () => app.showText(`${agentName(app.state().selectedAgent)} · ${title}`, [{ title: '', text: value }]), { className: 'ol-iconbtn-sm' }) : null)),
            h('div', { class: `ol-prompt${long ? ' is-clamped' : ''}`, text: value }));
    }

    function routing(agent) {
        const rows = [
            [t('apiPreset'), agent.apiPreset || t('followGlobal'), !agent.apiPreset],
            [t('promptPreset'), agent.promptPreset || t('followGlobal'), !agent.promptPreset],
        ];
        return h('section', { class: 'ol-insp-section' },
            h('div', { class: 'ol-section-title' }, h('span', { text: t('model') })),
            h('dl', { class: 'ol-kv is-wide' }, rows.map(([k, v, muted]) => [h('dt', { text: k }), h('dd', { class: muted ? 'is-muted' : '', text: v })])));
    }

    function toolsBlock(agent) {
        const own = agent.tools;
        const list = own ?? agent.inheritedTools ?? [];
        return h('section', { class: 'ol-insp-section' },
            h('div', { class: 'ol-section-title' }, h('span', { text: t('tools') }), own === null && agent.inheritedTools ? h('span', { class: 'ol-insp-note', text: t('inheritTools') }) : null),
            list.length
                ? h('div', { class: 'ol-toolcloud' }, list.map(name => h('span', { class: 'ol-chip', title: name, text: toolName(name) })))
                : h('p', { class: 'ol-muted', text: t('noTools') }));
    }

    function activity(agentId) {
        const run = app.run();
        if (!run) return null;
        const segs = run.segments.filter(seg => seg.agentId === agentId);
        if (!segs.length) return h('section', { class: 'ol-insp-section' },
            h('div', { class: 'ol-section-title' }, h('span', { text: t('lastOutput') })),
            h('p', { class: 'ol-muted', text: run.status === 'running' ? t('nodeWaiting') : t('noOutput') }));
        const selectedKey = app.state().selectedSegment;
        const seg = segs.find(item => item.key === selectedKey) || segs[segs.length - 1];
        return h('section', { class: 'ol-insp-section' },
            h('div', { class: 'ol-section-title' },
                h('span', { text: t('lastOutput') }),
                h('span', { class: 'ol-insp-note', text: [segs.length > 1 ? `共 ${segs.length} 次` : '', formatDuration(seg.duration), statusLabel(seg.status)].filter(Boolean).join(' · ') })),
            segs.length > 1 ? h('div', { class: 'ol-insp-attempts' }, segs.map((item, i) => h('button', {
                type: 'button',
                class: 'ol-attempt',
                dataset: { status: item.status },
                'aria-pressed': String(item === seg),
                onClick: () => app.selectSegment(item.key, agentId),
                text: String(i + 1),
            }))) : null,
            renderSections(seg.sections, { app, mode: run.mode, agentId }));
    }

    function overview() {
        const flow = app.flow();
        if (!flow) return emptyState('flow', t('selectHint'));
        const info = modeInfo(flow.mode);
        const run = app.run();
        return h('div', { class: 'ol-insp-overview' },
            h('div', { class: 'ol-insp-head' },
                h('span', { class: 'ol-brand-mark', 'aria-hidden': 'true' }, icon('conductor', { size: 17 })),
                h('div', null, h('h3', { text: info.label }), h('span', { class: 'ol-insp-sub', text: info.hint }))),
            h('dl', { class: 'ol-kv is-wide' },
                h('dt', { text: t('agents') }), h('dd', { text: String(Object.keys(flow.agents).length) }),
                flow.mode === 'spec' || flow.mode === 'single' ? [h('dt', { text: t('stages') }), h('dd', { text: String(flow.columns.length) })] : null,
                flow.presetName ? [h('dt', { text: '方案' }), h('dd', { text: flow.presetName })] : null,
                h('dt', { text: '用于' }), h('dd', { text: flow.scopeLabel })),
            run?.finalText ? h('section', { class: 'ol-insp-section' },
                h('div', { class: 'ol-section-title' }, h('span', { text: t('runFinal') }), iconButton('copy', t('copy'), async () => { if (await copyText(run.finalText)) app.notify(t('copied')); }, { className: 'ol-iconbtn-sm' })),
                h('div', { class: 'ol-prompt is-clamped', text: run.finalText })) : null,
            h('p', { class: 'ol-muted ol-insp-hint', text: t('selectHint') }));
    }

    function render() {
        clear(bodyEl);
        const id = app.state().selectedAgent;
        const flow = app.flow();
        if (!id) {
            put(bodyEl, overview());
            return;
        }
        const agent = flow?.agents?.[id] || null;
        put(bodyEl,
            h('div', { class: 'ol-insp-head', dataset: { tone: toneOf(id) } },
                agentAvatar(id, { size: 'lg' }),
                h('div', { class: 'ol-insp-titles' },
                    h('h3', { text: agentName(id) }),
                    agentName(id) !== id ? h('span', { class: 'ol-insp-id', text: id }) : null),
                h('span', { class: 'ol-spacer' }),
                iconButton('x', t('close'), () => app.selectAgent(''), { className: 'ol-iconbtn-sm' })),
            agentRole(id) || agent?.description ? h('p', { class: 'ol-insp-role', text: agentRole(id) || agent.description }) : null,
            agentRole(id) && agent?.description ? promptBlock(t('description'), agent.description) : null,
            // The run view shows the selected step in its own detail pane.
            app.state().view === 'run' ? null : activity(id),
            agent ? promptBlock(t('systemPrompt'), agent.systemPrompt) : null,
            agent ? promptBlock(t('userPrompt'), agent.userPrompt) : null,
            agent ? routing(agent) : null,
            agent ? toolsBlock(agent) : null,
            !agent ? h('p', { class: 'ol-muted', text: '这位助手不在当前方案里（可能是临时派遣，或方案已更换）。' }) : null);
    }

    return { el, render, onRunUpdate: () => { if (app.state().selectedAgent) render(); } };
}
