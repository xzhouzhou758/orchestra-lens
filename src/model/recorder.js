// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Listens to the orchestrator's run store and keeps:
//   - a live copy of the current run, plus per-section start/end stamps
//     (the store only times rounds; spec nodes share one round per stage)
//   - a small history of finished runs, persisted to localStorage
//
// The store's events carry ids only; we read the data via getCurrentRun().
// No DOM. `storage` is injectable so Node tests can pass a Map-backed shim.

const HISTORY_KEY = 'orchestraLens.history.v1';
const MAX_RUNS = 30;
const MAX_BODY = 24000;
const TERMINAL = new Set(['done', 'failed']);

function cloneRun(run, { truncate = false } = {}) {
    if (!run) return null;
    const cut = (text) => {
        const value = String(text ?? '');
        return truncate && value.length > MAX_BODY ? `${value.slice(0, MAX_BODY)}\n…（内容过长，已截断）` : value;
    };
    let meta;
    const safeMeta = (value) => {
        if (value == null) return null;
        try { return JSON.parse(JSON.stringify(value)); } catch { return null; }
    };
    return {
        runId: run.runId,
        mode: run.mode,
        status: run.status,
        startedAt: run.startedAt,
        endedAt: run.endedAt,
        chatKey: run.chatKey,
        finalText: run.finalText == null ? null : cut(run.finalText),
        error: run.error,
        tokensSpent: run.tokensSpent ? { ...run.tokensSpent } : null,
        quiet: Boolean(run.quiet),
        rounds: (run.rounds || []).map(round => ({
            id: round.id,
            label: round.label,
            status: round.status,
            startedAt: round.startedAt,
            endedAt: round.endedAt,
            sections: (round.sections || []).map(section => (meta = safeMeta(section.meta), {
                id: section.id,
                kind: section.kind,
                title: section.title,
                status: section.status,
                body: cut(section.body),
                meta,
            })),
        })),
    };
}

export function createMemoryStorage() {
    const map = new Map();
    return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k) };
}

/**
 * @param {{ storage?: Storage, now?: () => number, wallNow?: () => number, getRunContext?: () => object }} options
 *   getRunContext: called once when a run starts; returns { chatId, floor, chatLabel, presetName }.
 */
export function createRecorder({ storage = globalThis.localStorage, now = () => globalThis.performance?.now?.() ?? Date.now(), wallNow = () => Date.now(), getRunContext = () => ({}) } = {}) {
    let store = null;
    let unsubscribe = null;
    let current = null; // { run (live ref), times, context, startedAtWall }
    const listeners = new Set();
    let history = loadHistory();
    let notifyQueued = false;

    function loadHistory() {
        try {
            const parsed = JSON.parse(storage?.getItem(HISTORY_KEY) || '[]');
            return Array.isArray(parsed) ? parsed : [];
        } catch {
            return [];
        }
    }

    function saveHistory() {
        try {
            storage?.setItem(HISTORY_KEY, JSON.stringify(history));
        } catch {
            // Quota: drop the oldest half and retry once.
            history = history.slice(0, Math.floor(history.length / 2));
            try { storage?.setItem(HISTORY_KEY, JSON.stringify(history)); } catch { /* give up quietly */ }
        }
    }

    function emit(kind) {
        for (const fn of [...listeners]) {
            try { fn(kind); } catch (err) { console.error('[orchestra-lens] listener failed', err); }
        }
    }

    // Token streams fire many events per frame; collapse UI notifications.
    function emitSoon() {
        if (notifyQueued) return;
        notifyQueued = true;
        const flush = () => { notifyQueued = false; emit('update'); };
        if (globalThis.requestAnimationFrame) globalThis.requestAnimationFrame(flush);
        else queueMicrotask(flush);
    }

    function stamp(key, field) {
        if (!current) return;
        const entry = current.times[key] || (current.times[key] = {});
        if (field === 'start' && entry.start != null) return;
        entry[field] = now();
    }

    function finalize() {
        if (!current) return;
        const snap = snapshotCurrent({ truncate: true });
        current.finished = true;
        if (!snap || snap.quiet) return;
        history = [snap, ...history.filter(item => item.runId !== snap.runId)].slice(0, MAX_RUNS);
        saveHistory();
    }

    function onEvent(event) {
        const run = store?.getCurrentRun?.() || null;
        switch (event?.type) {
            case 'run_started': {
                let context = {};
                try { context = getRunContext() || {}; } catch { context = {}; }
                current = { run, times: {}, context, startedAtWall: wallNow(), finished: false };
                emit('start');
                return;
            }
            case 'section_ensured':
                stamp(`${event.roundId}/${event.sectionId}`, 'start');
                break;
            case 'section_status':
                if (TERMINAL.has(event.status)) stamp(`${event.roundId}/${event.sectionId}`, 'end');
                break;
            case 'run_finished':
                // Director can report twice (stop + cleanup); keep the first.
                if (current && run && current.run === run && !current.finished) {
                    finalize();
                    emit('finish');
                }
                return;
            case 'run_cleared':
                if (current && !current.finished) finalize();
                current = current ? { ...current, run: null, cleared: true } : null;
                emit('clear');
                return;
            default:
                break;
        }
        if (current && run && current.run !== run) current.run = run;
        emitSoon();
    }

    function snapshotCurrent({ truncate = false } = {}) {
        if (!current?.run) return current?.lastSnap || null;
        const snap = cloneRun(current.run, { truncate });
        snap.times = JSON.parse(JSON.stringify(current.times));
        snap.startedAtWall = current.startedAtWall;
        snap.now = now();
        Object.assign(snap, {
            chatId: String(current.context.chatId || ''),
            chatLabel: String(current.context.chatLabel || ''),
            floor: Number(current.context.floor) || 0,
            presetName: String(current.context.presetName || ''),
        });
        current.lastSnap = snap;
        return snap;
    }

    return {
        attach(nextStore) {
            if (store === nextStore) return;
            unsubscribe?.();
            store = nextStore;
            unsubscribe = store?.subscribe?.(onEvent) || null;
            // A run may already be in flight when the lens opens.
            const run = store?.getCurrentRun?.();
            if (run && !current) {
                let context = {};
                try { context = getRunContext() || {}; } catch { context = {}; }
                current = { run, times: {}, context, startedAtWall: wallNow() - Math.max(0, now() - (run.startedAt || now())), finished: run.status !== 'running' };
            }
        },
        detach() {
            unsubscribe?.();
            unsubscribe = null;
            store = null;
        },
        /** Live run (fresh snapshot each call) or the last one seen this session. */
        current: () => snapshotCurrent(),
        isRunning: () => current?.run?.status === 'running',
        stop() {
            const run = current?.run;
            if (run?.status !== 'running') return false;
            const fn = run.stopFn || run.abortFn;
            if (typeof fn !== 'function') return false;
            fn();
            return true;
        },
        history: () => history.slice(),
        removeWhere(predicate) {
            history = history.filter(item => !predicate(item));
            saveHistory();
            emit('history');
        },
        subscribe(fn) {
            listeners.add(fn);
            return () => listeners.delete(fn);
        },
        /** test hook */
        _onEvent: onEvent,
    };
}
