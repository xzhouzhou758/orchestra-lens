// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Reviewable list of agent-field changes: one row per changed field, with an
// optional checkbox and a fold-out before / after. Used for AI proposals
// (pick what to apply) and the save review (read-only list).

import { h, clear, put } from '../util.js';
import { icon } from '../icons.js';
import { agentName } from '../i18n.js';
import { FIELD_LABELS } from '../model/edit.js';
import { button } from '../ui/components.js';

export function changeText(change) {
    return `${agentName(change.agentId)} · ${FIELD_LABELS[change.field] || change.field}`;
}

/** Character-level diff (common prefix / suffix) → highlighted spans. */
export function markDiff(a, b) {
    let start = 0;
    while (start < a.length && start < b.length && a[start] === b[start]) start++;
    let endA = a.length;
    let endB = b.length;
    while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
    // Long unchanged runs are shortened so the change is visible.
    const ctx = (text, from, to) => {
        const head = text.slice(0, from);
        const tail = text.slice(to);
        return [head.length > 160 ? `…${head.slice(-140)}` : head, text.slice(from, to), tail.length > 160 ? `${tail.slice(0, 140)}…` : tail];
    };
    const pieces = (text, from, to, cls) => {
        if (!text) return [h('span', { class: 'ol-diff-empty', text: '（空 · 跟随默认）' })];
        const [head, mid, tail] = ctx(text, from, to);
        return [head ? h('span', { text: head }) : null, mid ? h('mark', { class: cls, text: mid }) : null, tail ? h('span', { text: tail }) : null].filter(Boolean);
    };
    return { before: pieces(a, start, endA, 'is-del'), after: pieces(b, start, endB, 'is-add') };
}

export function diffBlock(change) {
    const { before, after } = markDiff(change.before || '', change.after || '');
    return h('div', { class: 'ol-change-detail' },
        h('div', { class: 'ol-diff-label', text: '原来' }), h('p', { class: 'ol-diff-before' }, before),
        h('div', { class: 'ol-diff-label', text: '改为' }), h('p', { class: 'ol-diff-after' }, after));
}

/**
 * @param {{ changes: object[], state?: 'pending'|'applied'|'discarded'|'undone'|'superseded'|'review',
 *   applied?: Set<string>, stale?: Set<string>, open?: boolean, onApply?(chosen: object[]): void,
 *   onDiscard?(): void, onUndo?(): void, onFocus?(change: object): void }} opts
 */
export function changeList(opts) {
    const { changes, state = 'pending', applied = new Set(), stale = new Set(), open = false, onApply, onDiscard, onUndo, onFocus } = opts;
    const chosen = new Set(changes.filter(c => !stale.has(c.id)).map(c => c.id));
    const checkable = state === 'pending';
    const el = h('section', { class: 'ol-changes', dataset: { state } });

    function row(change) {
        const isStale = stale.has(change.id);
        const box = checkable || state === 'applied' ? h('button', {
            type: 'button',
            role: 'checkbox',
            class: 'ol-check ol-check-hit',
            'aria-checked': String(checkable ? chosen.has(change.id) : applied.has(change.id)),
            'aria-label': changeText(change),
            disabled: !checkable || isStale,
            onClick: () => {
                if (chosen.has(change.id)) chosen.delete(change.id); else chosen.add(change.id);
                box.setAttribute('aria-checked', String(chosen.has(change.id)));
                paintFoot();
            },
        }, icon('check', { size: 11 })) : null;
        const detail = diffBlock(change);
        detail.hidden = !open;
        let caret = icon(open ? 'chevronUp' : 'chevronDown', { size: 12, className: 'ol-change-caret' });
        const text = h('button', {
            type: 'button',
            class: 'ol-change-text',
            'aria-expanded': String(open),
            onClick: () => {
                detail.hidden = !detail.hidden;
                text.setAttribute('aria-expanded', String(!detail.hidden));
                const next = icon(detail.hidden ? 'chevronDown' : 'chevronUp', { size: 12, className: 'ol-change-caret' });
                caret.replaceWith(next);
                caret = next;
                onFocus?.(change);
            },
        },
        h('span', { class: 'ol-change-agent', text: agentName(change.agentId) }),
        h('span', { class: 'ol-change-field', text: FIELD_LABELS[change.field] || change.field }),
        isStale ? h('span', { class: 'ol-change-stale', text: '你已手动改过', title: '这一项在 AI 改完后你又手动改过，不能直接应用' }) : null,
        caret);
        return h('li', { class: `ol-change${isStale ? ' is-stale' : ''}` }, h('div', { class: 'ol-change-line' }, box, text), detail);
    }

    const foot = h('div', { class: 'ol-changes-foot' });
    function paintFoot() {
        clear(foot);
        if (state === 'pending') {
            put(foot,
                button(`应用所选（${chosen.size}）`, () => onApply?.(changes.filter(c => chosen.has(c.id))), { iconName: 'check', className: 'ol-btn-sm ol-btn-primary', disabled: !chosen.size }),
                button('全部放弃', () => onDiscard?.(), { className: 'ol-btn-sm ol-btn-ghost' }));
        } else if (state === 'applied') {
            put(foot,
                h('span', { class: 'ol-changes-state', text: `已放进草稿 ${applied.size} 处，保存后生效` }),
                onUndo ? button('撤销这一轮', () => onUndo(), { iconName: 'undo', className: 'ol-btn-sm ol-btn-ghost' }) : null);
        } else if (state !== 'review') {
            const text = { undone: '已撤销', superseded: '已被下一轮的修改取代', discarded: '已放弃' }[state] || '';
            put(foot, h('span', { class: 'ol-changes-state', text }));
        }
    }
    paintFoot();

    put(el,
        state === 'review' ? null : h('div', { class: 'ol-changes-head', text: state === 'pending' ? `AI 建议修改 ${changes.length} 处` : `AI 修改了 ${changes.length} 处` }),
        h('ul', { class: 'ol-changes-list' }, changes.map(row)),
        state === 'review' ? null : foot);
    return el;
}
