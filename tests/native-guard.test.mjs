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

function fakeDoc(linkSpecs, { baseURI = 'https://example.com/' } = {}) {
    const links = linkSpecs.map(spec => typeof spec === 'string' ? fakeLink(spec) : fakeLink(spec.href, spec));
    const classes = new Set(['ol-takeover']);
    return {
        baseURI,
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

test('removeOwnStylesheets avoids Safari WebKit @import race when link.sheet appears before load fires', () => {
    const href = 'https://example.com/scripts/extensions/third-party/orchestra-lens/style.css';
    const doc = fakeDoc([
        { href: '/scripts/extensions/third-party/orchestra-lens/style.css', loaded: false },
    ]);
    let onloadResolved = false;
    doc.links[0].onload = () => { onloadResolved = true; };

    assert.equal(removeOwnStylesheets(doc, href), 1);
    assert.equal(doc.links[0].media, 'not all');
    assert.equal(doc.links[0].removed, false);

    // 模拟 Safari/WebKit 在子 @import 尚未加载完前暴露 link.sheet，随后 MutationObserver 再次触发清理
    doc.links[0].sheet = {};
    assert.equal(removeOwnStylesheets(doc, href), 1);
    assert.equal(doc.links[0].disabled, false);
    assert.equal(doc.links[0].removed, false);

    doc.links[0].fire('load');
    assert.equal(onloadResolved, true);
    assert.equal(doc.links[0].disabled, true);
    assert.equal(doc.links[0].removed, true);
});

test('retireIfNativeOrchestraLens does not force-remove in-flight link on 15s timeout or 1500ms fallback, only on APP_READY', () => {
    const href = 'https://example.com/scripts/extensions/third-party/orchestra-lens/style.css';
    const origSetTimeout = globalThis.setTimeout;
    const origMutationObserver = globalThis.MutationObserver;
    const timers = [];
    let observerDisconnected = false;

    globalThis.setTimeout = (fn, ms) => {
        timers.push({ fn, ms });
        return timers.length;
    };
    globalThis.MutationObserver = class FakeObserver {
        observe() {}
        disconnect() { observerDisconnected = true; }
    };

    try {
        const fallbackDoc = fakeDoc([
            { href: '/scripts/extensions/third-party/orchestra-lens/style.css', loaded: false },
        ]);
        const fallbackNotices = [];
        retireIfNativeOrchestraLens({
            ownStyleHref: href,
            ctx: { runPanel: { attachDock() {} }, getCurrentLocale: () => 'zh-tw' },
            doc: fallbackDoc,
            notify: (msg, title) => fallbackNotices.push({ msg, title }),
        });

        fallbackDoc.links[0].sheet = {};
        const t15s = timers.find(t => t.ms === 15000);
        const t1500 = timers.find(t => t.ms === 1500);
        assert.ok(t15s && t1500);

        t15s.fn();
        assert.equal(observerDisconnected, true);
        assert.equal(fallbackDoc.links[0].removed, false);

        t1500.fn();
        assert.equal(fallbackNotices.length, 1);
        assert.equal(fallbackDoc.links[0].removed, false);

        const readyDoc = fakeDoc([
            { href: '/scripts/extensions/third-party/orchestra-lens/style.css', loaded: false },
        ]);
        let readyCb = null;
        retireIfNativeOrchestraLens({
            ownStyleHref: href,
            ctx: {
                runPanel: { attachDock() {} },
                eventTypes: { APP_READY: 'app_ready' },
                eventSource: { once(ev, cb) { if (ev === 'app_ready') readyCb = cb; } },
                getCurrentLocale: () => 'zh-tw',
            },
            doc: readyDoc,
            notify: () => {},
        });
        readyDoc.links[0].sheet = {};
        assert.equal(readyDoc.links[0].removed, false);
        readyCb?.();
        assert.equal(readyDoc.links[0].disabled, true);
        assert.equal(readyDoc.links[0].removed, true);
    } finally {
        globalThis.setTimeout = origSetTimeout;
        globalThis.MutationObserver = origMutationObserver;
    }
});

test('retireIfNativeOrchestraLens localizes zh-TW/zh-Hant and falls back to English for non-zh or empty locale', () => {
    const href = 'https://example.com/scripts/extensions/third-party/orchestra-lens/style.css';
    for (const locale of ['zh-tw', 'zh-HK', 'zh-MO', 'zh-Hant']) {
        let readyCb = null;
        const notices = [];
        retireIfNativeOrchestraLens({
            ownStyleHref: href,
            ctx: {
                runPanel: { attachDock() {} },
                eventTypes: { APP_READY: 'app_ready' },
                eventSource: { once(_ev, cb) { readyCb = cb; } },
                getCurrentLocale: () => locale,
            },
            doc: fakeDoc([]),
            notify: (msg, title) => notices.push({ msg, title }),
        });
        readyCb?.();
        assert.equal(notices.length, 1);
        assert.match(notices[0].title, /舊擴充功能已停用/);
        assert.match(notices[0].msg, /管理擴充功能/);
        assert.match(notices[0].msg, /移除/);
        assert.doesNotMatch(notices[0].msg, /管理擴充套件/);
    }

    const origNav = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    Object.defineProperty(globalThis, 'navigator', { value: { language: '' }, configurable: true });
    try {
        let readyCb = null;
        const notices = [];
        retireIfNativeOrchestraLens({
            ownStyleHref: href,
            ctx: {
                runPanel: { attachDock() {} },
                eventTypes: { APP_READY: 'app_ready' },
                eventSource: { once(_ev, cb) { readyCb = cb; } },
                getCurrentLocale: () => '',
            },
            doc: fakeDoc([]),
            notify: (msg, title) => notices.push({ msg, title }),
        });
        readyCb?.();
        assert.equal(notices.length, 1);
        assert.match(notices[0].msg, /Manage Extensions/);
    } finally {
        if (origNav) Object.defineProperty(globalThis, 'navigator', origNav);
        else delete globalThis.navigator;
    }
});

test('removeOwnStylesheets and isNativeOrchestraLensPresent ignore data: and blob: baseURI', () => {
    const ownHref = 'https://example.com/scripts/extensions/third-party/orchestra-lens/style.css';
    for (const baseURI of ['data:text/html,<h1>sandbox</h1>', 'blob:https://example.com/1234-5678']) {
        const doc = fakeDoc([
            { href: '/scripts/extensions/orchestrator/lens/style.css?v=1', loaded: true },
            { href: '/scripts/extensions/third-party/orchestra-lens/style.css?v=1', loaded: true },
        ], { baseURI });
        assert.equal(isNativeOrchestraLensPresent({}, doc), true);
        assert.equal(removeOwnStylesheets(doc, ownHref), 1);
        assert.equal(doc.links[0].removed, false);
        assert.equal(doc.links[1].disabled, true);
        assert.equal(doc.links[1].removed, true);
    }
});
