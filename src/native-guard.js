// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 原生编排透镜退场守卫：当检测到 Luker 已内置原生编排工作区与共享运行面板（PR #58 及之后版本）时，
// 立即移除本扩展自身注入的 style.css 与 ol-takeover 标记，跳过接管运行面板，并提示卸载。

function normalizePathname(href, doc) {
    const raw = String(href || '').trim();
    if (!raw) return '';
    try {
        const base = doc?.baseURI || globalThis.location?.href || 'http://localhost/';
        return new URL(raw, base).pathname.toLowerCase();
    } catch {
        return raw.split(/[?#]/)[0].toLowerCase();
    }
}

function hasStylesheetPathSuffix(doc, suffix) {
    if (!doc?.head || !suffix) return false;
    const expected = suffix.toLowerCase();
    for (const link of doc.head.querySelectorAll('link[href]')) {
        const rawHref = link.getAttribute?.('href') || link.href || '';
        if (normalizePathname(rawHref, doc).endsWith(expected)) return true;
    }
    return false;
}

function isZhLocale(ctx) {
    try {
        const locale = String(ctx?.getCurrentLocale?.() || globalThis.navigator?.language || '');
        return !locale || locale.toLowerCase().startsWith('zh');
    } catch {
        return true;
    }
}

/**
 * 判断当前 Luker 是否已内置原生编排透镜 / 共享运行面板。
 * @param {object | null | undefined} [ctx]
 * @param {Document | null | undefined} [doc]
 * @returns {boolean}
 */
export function isNativeOrchestraLensPresent(
    ctx = globalThis.Luker?.getContext?.(),
    doc = globalThis.document,
) {
    if (ctx?.runPanel && typeof ctx.runPanel.attachDock === 'function') return true;
    if (ctx?.workbench && typeof ctx.workbench.registerWorkspace === 'function') return true;
    return hasStylesheetPathSuffix(doc, '/scripts/extensions/orchestrator/lens/style.css');
}

/**
 * 从文档 head 中移除与本插件样式路径匹配的 <link> 标签。
 * @param {Document | null | undefined} doc
 * @param {string} ownStyleHref
 * @returns {number} 移除的标签数量
 */
export function removeOwnStylesheets(doc, ownStyleHref) {
    if (!doc?.head || !ownStyleHref) return 0;
    const targetPath = normalizePathname(ownStyleHref, doc);
    if (!targetPath) return 0;
    let removed = 0;
    for (const link of doc.head.querySelectorAll('link[href]')) {
        const rawHref = link.getAttribute?.('href') || link.href || '';
        if (normalizePathname(rawHref, doc) === targetPath) {
            link.remove();
            removed++;
        }
    }
    return removed;
}

/**
 * 若检测到 Luker 已内置原生编排透镜，则移除自身样式并安排一次性卸载提醒。
 * @param {{ ownStyleHref: string, ctx?: object | null, doc?: Document | null, notify?: (msg: string, title: string) => void }} options
 * @returns {boolean} 是否已退场（true 表示跳过旧插件初始化）
 */
export function retireIfNativeOrchestraLens({
    ownStyleHref,
    ctx = globalThis.Luker?.getContext?.(),
    doc = globalThis.document,
    notify = (msg, title) => globalThis.toastr?.warning?.(msg, title, { timeOut: 12000 }),
} = {}) {
    if (!isNativeOrchestraLensPresent(ctx, doc)) return false;

    const cleanup = () => {
        removeOwnStylesheets(doc, ownStyleHref);
        doc?.documentElement?.classList?.remove?.('ol-takeover');
    };
    cleanup();

    let observer = null;
    if (doc?.head && typeof globalThis.MutationObserver === 'function') {
        observer = new globalThis.MutationObserver(() => cleanup());
        observer.observe(doc.head, { childList: true });
        globalThis.setTimeout?.(() => {
            cleanup();
            observer?.disconnect();
            observer = null;
        }, 15000);
    }

    const zh = isZhLocale(ctx);
    const title = zh ? '编排透镜（旧插件已停用）' : 'Orchestra Lens (Legacy Plugin Disabled)';
    const message = zh
        ? 'Luker 已原生内置「编排工作区与运行面板」，旧版第三方插件 orchestra-lens 已自动停用并移除旧样式。请在「管理扩展」中卸载此旧插件以避免冲突。'
        : 'Orchestra Lens and the shared Run Dock are now built into Luker. Legacy plugin orchestra-lens has disabled itself and removed its stylesheet. Please uninstall it from Manage Extensions.';

    console.warn(`[orchestra-lens] ${message}`);

    let notified = false;
    const emitNotice = () => {
        if (notified) return;
        notified = true;
        cleanup();
        observer?.disconnect();
        observer = null;
        try { notify?.(message, title); } catch { /* ignore */ }
    };

    try {
        const ready = ctx?.eventTypes?.APP_READY;
        if (ready && typeof ctx.eventSource?.once === 'function') {
            ctx.eventSource.once(ready, emitNotice);
        } else if (ready && typeof ctx.eventSource?.on === 'function') {
            ctx.eventSource.on(ready, emitNotice);
        } else {
            globalThis.setTimeout?.(emitNotice, 1500);
        }
    } catch {
        globalThis.setTimeout?.(emitNotice, 1500);
    }

    return true;
}
