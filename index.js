// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Orchestra Lens — Luker entry point.
//   - wand-menu item → full-screen lens (loaded lazily on first open)
//   - a recorder on every run-panel store (orchestrator + search agent), so
//     runs are captured even while the lens is closed
//   - the side dock that replaces Luker's own run panels (can be turned off
//     from the dock's menu; then the native panels come back)

const MENU_ID = 'orchestra_lens_wand_item';
const DOCK_MENU_ID = 'orchestra_lens_dock_item';
const TAKEOVER_KEY = 'orchestraLens.takeover';
let handle = null;
let opening = null;
let runtimeReady = null;

function isZh() {
    try {
        const locale = String(globalThis.Luker?.getContext?.()?.getCurrentLocale?.() || navigator.language || '');
        return locale.toLowerCase().startsWith('zh');
    } catch {
        return true;
    }
}

export function takeoverEnabled() {
    try { return globalThis.localStorage?.getItem(TAKEOVER_KEY) !== 'off'; } catch { return true; }
}

function startRuntime() {
    if (!runtimeReady) {
        runtimeReady = (async () => {
            const [{ createRecorder }, { createLukerSource }, takeover] = await Promise.all([
                import('./src/model/recorder.js'),
                import('./src/source-luker.js'),
                import('./src/dock/takeover.js'),
            ]);
            const source = createLukerSource();
            const recorder = createRecorder({ getRunContext: (from) => source.runContext(from) });
            let dock = null;
            let lastStart = 0;
            recorder.subscribe((kind) => { if (kind === 'start') lastStart = Date.now(); });
            const enabled = takeoverEnabled();
            takeover.setNativeHidden(enabled);
            await takeover.installTakeover({
                onStore: (store, from) => recorder.attach(store, from),
                // Native panels also open themselves when a run starts; only
                // redirect explicit opens (Luker's "show run panel" button).
                onNativeOpen: () => { if (Date.now() - lastStart > 800) dock?.open(); },
            });
            try {
                recorder.attach(await source.runStore(), 'orchestrator');
            } catch (err) {
                // Orchestrator missing or moved: the lens will show why when opened.
                console.info('[orchestra-lens] orchestrator run store not attached:', err?.message || err);
            }
            if (enabled) {
                const { createDock } = await import('./src/dock/dock.js');
                let flow = null;
                const refreshFlow = async () => {
                    try {
                        const [{ buildFlow }, snap] = await Promise.all([import('./src/model/profile.js'), source.load()]);
                        flow = buildFlow(snap.profile, { mode: snap.mode, settings: snap.settings });
                    } catch { flow = null; }
                };
                void refreshFlow();
                recorder.subscribe((kind) => { if (kind === 'start') void refreshFlow().then(() => dock?.refresh()); });
                dock = createDock({ recorder, getFlow: () => flow, openLens: (key) => open(key), onRestoreNative: () => setTakeover(false) });
            }
            return { recorder, source, dock: () => dock, takeover, takeoverEnabled, setTakeover };
        })().catch((err) => {
            console.error('[orchestra-lens] failed to start', err);
            runtimeReady = null;
            throw err;
        });
    }
    return runtimeReady;
}

async function open(runId = '') {
    if (handle) {
        handle.focus();
        if (runId) handle.app.openRun(runId);
        return;
    }
    if (opening) return opening;
    opening = (async () => {
        const [{ mountOrchestraLens }, { recorder, source, dock }] = await Promise.all([import('./src/app.js'), startRuntime()]);
        dock()?.close();
        handle = mountOrchestraLens({ source, recorder, takeover: { enabled: takeoverEnabled, set: setTakeover }, onClose: () => { handle = null; } });
        if (runId) handle.app.openRun(runId);
    })();
    try {
        await opening;
    } catch (err) {
        console.error('[orchestra-lens] failed to open', err);
        globalThis.toastr?.error?.(String(err?.message || err), isZh() ? '编排透镜' : 'Orchestra Lens');
    } finally {
        opening = null;
    }
}

function close() {
    handle?.close();
}

async function toggleDock() {
    const runtime = await startRuntime();
    const dock = runtime.dock();
    if (dock) dock.toggle();
    else globalThis.toastr?.info?.(isZh() ? '运行面板已关闭，可在编排透镜的历史页重新开启。' : 'The run panel is turned off.');
}

/** Turns the dock on/off. Off = Luker's own run panels come back (applies after reload). */
function setTakeover(on) {
    try { globalThis.localStorage?.setItem(TAKEOVER_KEY, on ? 'on' : 'off'); } catch { /* optional */ }
    globalThis.toastr?.info?.(isZh() ? '刷新页面后生效。' : 'Reload the page to apply.');
}

function menuItem(id, iconClass, label, onActivate) {
    const item = document.createElement('div');
    item.id = id;
    item.className = 'list-group-item flex-container flexGap5';
    item.tabIndex = 0;
    item.setAttribute('role', 'button');
    const icon = document.createElement('div');
    icon.className = `fa-solid ${iconClass} extensionsMenuExtensionButton`;
    const text = document.createElement('span');
    text.textContent = label;
    item.append(icon, text);
    item.addEventListener('click', () => onActivate());
    item.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onActivate();
        }
    });
    return item;
}

function addMenuItems() {
    const menu = document.getElementById('extensionsMenu');
    if (!menu) return false;
    if (!document.getElementById(MENU_ID)) menu.appendChild(menuItem(MENU_ID, 'fa-diagram-project', isZh() ? '编排透镜' : 'Orchestra Lens', () => open()));
    if (takeoverEnabled() && !document.getElementById(DOCK_MENU_ID)) menu.appendChild(menuItem(DOCK_MENU_ID, 'fa-list-check', isZh() ? '运行面板' : 'Run panel', toggleDock));
    return true;
}

if (!addMenuItems()) {
    const observer = new MutationObserver(() => {
        if (addMenuItems()) observer.disconnect();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => observer.disconnect(), 120000);
}

// Hide the native panels right away so they never flash; the rest waits a
// moment for Luker to finish activating extensions.
if (takeoverEnabled()) document.documentElement.classList.add('ol-takeover');
startRuntime().catch(() => {});

globalThis.OrchestraLens = Object.freeze({ open, close, toggleDock, setTakeover, takeoverEnabled });
