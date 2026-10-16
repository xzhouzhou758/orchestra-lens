// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Orchestra Lens — Luker entry point. Adds a wand-menu item, and starts a
// tiny recorder on the orchestrator's run store so runs are captured even
// while the lens is closed. The UI itself loads lazily on first open.

const MENU_ID = 'orchestra_lens_wand_item';
let handle = null;
let opening = null;
let recorderReady = null;

function isZh() {
    try {
        const locale = String(globalThis.Luker?.getContext?.()?.getCurrentLocale?.() || navigator.language || '');
        return locale.toLowerCase().startsWith('zh');
    } catch {
        return true;
    }
}

async function getSource() {
    const { createLukerSource } = await import('./src/source-luker.js');
    return createLukerSource();
}

function startRecorder() {
    if (!recorderReady) {
        recorderReady = (async () => {
            const [{ createRecorder }, source] = await Promise.all([import('./src/model/recorder.js'), getSource()]);
            const recorder = createRecorder({ getRunContext: () => source.runContext() });
            try {
                recorder.attach(await source.runStore());
            } catch (err) {
                // Orchestrator missing or moved: the lens will show why when opened.
                console.info('[orchestra-lens] run recorder not attached:', err?.message || err);
            }
            return { recorder, source };
        })();
    }
    return recorderReady;
}

async function open() {
    if (handle) {
        handle.focus();
        return;
    }
    if (opening) return opening;
    opening = (async () => {
        const [{ mountOrchestraLens }, { recorder, source }] = await Promise.all([import('./src/app.js'), startRecorder()]);
        handle = mountOrchestraLens({ source, recorder, onClose: () => { handle = null; } });
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

function addMenuItem() {
    const menu = document.getElementById('extensionsMenu');
    if (!menu) return false;
    if (document.getElementById(MENU_ID)) return true;
    const item = document.createElement('div');
    item.id = MENU_ID;
    item.className = 'list-group-item flex-container flexGap5';
    item.tabIndex = 0;
    item.setAttribute('role', 'button');
    const icon = document.createElement('div');
    icon.className = 'fa-solid fa-diagram-project extensionsMenuExtensionButton';
    const label = document.createElement('span');
    label.textContent = isZh() ? '编排透镜' : 'Orchestra Lens';
    item.append(icon, label);
    item.addEventListener('click', open);
    item.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            open();
        }
    });
    menu.appendChild(item);
    return true;
}

if (!addMenuItem()) {
    const observer = new MutationObserver(() => {
        if (addMenuItem()) observer.disconnect();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => observer.disconnect(), 120000);
}

// The orchestrator registers its store when its module loads; give Luker a
// moment to finish activating extensions before importing it.
setTimeout(() => { startRecorder(); }, 1500);

globalThis.OrchestraLens = Object.freeze({ open, close });
