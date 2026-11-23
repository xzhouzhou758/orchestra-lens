import test from 'node:test';
import assert from 'node:assert/strict';
import { isNativeOrchestraLensPresent, removeOwnStylesheets, retireIfNativeOrchestraLens } from '../src/native-guard.js';

function fakeLink(href, { loaded = false } = {}) {
    const listeners = { load: [], error: [] };
    return {
        href,
        media: '',
        disabled: false,
        sheet: loaded ? {} : null,
        removed: false,
        onload: null,
        getAttribute(name) { return name === 'href' ? href : null; },
        addEventListener(type, fn) { listeners[type]?.push(fn); },
        fire(type) {
            if (type === 'load') {
                this.sheet = {};
                this.onload?.();
            }
            for (const fn of listeners[type] || []) fn();
        },
        remove() { this.removed = true; },
    };
}

function fakeDoc(linkSpecs) {
    const links = linkSpecs.map(spec => typeof spec === 'string' ? fakeLink(spec) : fakeLink(spec.href, spec));
    const classes = new Set(['ol-takeover']);
    return {
        baseURI: 'https://example.com/',
        links,
        documentElement: {
            classList: {
                has: (c) => classes.has(c),
                remove: (c) => classes.delete(c),
            },
        },
        head: {
            querySelectorAll() { return links.filter(l => !l.removed); },
        },
    };
}

test('isNativeOrchestraLensPresent detects native Run Dock API, Workbench API, or built-in orchestrator stylesheet', () => {
    const emptyDoc = fakeDoc(['/scripts/extensions/third-party/orchestra-lens/style.css']);
    assert.equal(isNativeOrchestraLensPresent({}, emptyDoc), false);
    assert.equal(isNativeOrchestraLensPresent({ runPanel: { createRunStore() {} } }, emptyDoc), false);
    assert.equal(isNativeOrchestraLensPresent({ runPanel: { attachDock() {} } }, emptyDoc), true);
    assert.equal(isNativeOrchestraLensPresent({ workbench: { registerWorkspace() {} } }, emptyDoc), true);

    const nativeStyleDoc = fakeDoc([
        '/scripts/extensions/orchestrator/lens/style.css',
        '/scripts/extensions/third-party/orchestra-lens/style.css',
    ]);
    assert.equal(isNativeOrchestraLensPresent({}, nativeStyleDoc), true);
});

test('retireIfNativeOrchestraLens defers removing in-flight CSS until load fires, clears ol-takeover, and notifies once', () => {
    const doc = fakeDoc([
        { href: '/scripts/extensions/orchestrator/lens/style.css', loaded: true },
        { href: '/scripts/extensions/third-party/orchestra-lens/style.css', loaded: false },
    ]);
    let onloadResolved = false;
    doc.links[1].onload = () => { onloadResolved = true; };

    let readyCb = null;
    const notices = [];
    const ctx = {
        runPanel: { attachDock() {} },
        eventTypes: { APP_READY: 'app_ready' },
        eventSource: { once(ev, cb) { if (ev === 'app_ready') readyCb = cb; } },
        getCurrentLocale: () => 'zh-cn',
    };

    const retired = retireIfNativeOrchestraLens({
        ownStyleHref: 'https://example.com/scripts/extensions/third-party/orchestra-lens/style.css',
        ctx,
        doc,
        notify: (msg, title) => notices.push({ msg, title }),
    });

    assert.equal(retired, true);
    assert.equal(doc.links[0].removed, false);
    assert.equal(doc.links[1].media, 'not all');
    assert.equal(doc.links[1].removed, false);
    assert.equal(doc.documentElement.classList.has('ol-takeover'), false);

    doc.links[1].fire('load');
    assert.equal(onloadResolved, true);
    assert.equal(doc.links[1].disabled, true);
    assert.equal(doc.links[1].removed, true);

    readyCb?.();
    assert.equal(notices.length, 1);
    assert.match(notices[0].msg, /orchestra-lens/);
});

test('retireIfNativeOrchestraLens stays inactive on older Luker without attachDock/workbench', () => {
    const doc = fakeDoc([
        { href: '/scripts/extensions/third-party/orchestra-lens/style.css', loaded: true },
    ]);
    assert.equal(retireIfNativeOrchestraLens({
        ownStyleHref: 'https://example.com/scripts/extensions/third-party/orchestra-lens/style.css',
        ctx: { runPanel: { createRunStore() {} } },
        doc,
    }), false);
    assert.equal(doc.links[0].removed, false);
    assert.equal(doc.documentElement.classList.has('ol-takeover'), true);
    assert.equal(removeOwnStylesheets(doc, 'https://example.com/scripts/extensions/third-party/orchestra-lens/style.css'), 1);
    assert.equal(doc.links[0].removed, true);
});
