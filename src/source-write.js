// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Luker-side writes and model access for the editing / AI features.
//
// Saving agent fields: re-read the stored profile for the same target
// (mode + scope + preset id), put only the changed fields on top (so the
// rest, including edits made in the native editor meanwhile, survives) and
// write it the way the orchestrator's own editor does. Afterwards the native
// editor's cached drafts are reloaded (editor-state.js initializeUiState),
// otherwise its next save would overwrite ours.
//
// AI calls go through Luker's `iteration-library/runner.js`
// requestToolCallsWithRetry (the helper the orchestrator's own AI iteration
// studio uses), so the user's connection profile and generation preset
// (incl. any jailbreak) wrap our prompt untouched. Default model = the
// orchestrator's 「迭代 AI」 presets; the lens can pick its own.

import { mergeChanges } from './model/edit.js';

const ORCH = '/scripts/extensions/orchestrator';
const LENS_KEY = 'orchestra_lens';
const SESSIONS_KEY = 'orchestraLens.ai.v1';
const MODES = ['spec', 'single', 'agenda', 'loop', 'director'];

export class WriteError extends Error {
    constructor(code, message) {
        super(message || code);
        this.code = code;
    }
}

const clone = (value) => (value == null ? value : JSON.parse(JSON.stringify(value)));

let modules = null;
function loadModules() {
    if (!modules) {
        modules = Promise.all([
            import(`${ORCH}/preset-library.js`),
            import(`${ORCH}/editor-state.js`).catch(() => null),
            import(`${ORCH}/defaults.js`).catch(() => null),
        ]).then(([presets, editorState, defaults]) => ({ presets, editorState, defaults })).catch((err) => {
            modules = null;
            throw new WriteError('api', String(err?.message || err));
        });
    }
    return modules;
}

/** The stored profile for a target, in the same shape the lens reads. */
async function readTarget(ctx, settings, target) {
    const { presets, defaults } = await loadModules();
    const { mode, scope, presetId } = target;
    if (mode === 'single') {
        return {
            spec: { stages: [{ id: 'single', mode: 'serial', nodes: ['single_agent'] }] },
            presets: {
                single_agent: {
                    systemPrompt: String(settings.singleAgentSystemPrompt || defaults?.DEFAULT_SINGLE_AGENT_SYSTEM_PROMPT || ''),
                    userPromptTemplate: String(settings.singleAgentUserPromptTemplate || defaults?.DEFAULT_SINGLE_AGENT_USER_PROMPT_TEMPLATE || ''),
                },
            },
        };
    }
    if (scope === 'chat') {
        const agenda = settings.chatOverrides?.[target.chatKey]?.agenda;
        if (!agenda?.enabled) throw new WriteError('target-gone', '这个聊天的专用调度方案已被关闭');
        return clone(agenda);
    }
    if (scope === 'factory' || !presetId) throw new WriteError('no-preset', '还没有保存过方案。请先在原生面板里保存一次，再回来修改。');
    const entry = presets.getPreset(settings, mode, scope, presetId, { context: ctx, avatar: target.avatar });
    if (!entry) throw new WriteError('target-gone', '要修改的方案已被删除或改名');
    return clone(entry);
}

async function writeTarget(ctx, settings, target, profile) {
    const { mode, scope, presetId } = target;
    if (mode === 'single') {
        const single = profile?.presets?.single_agent || {};
        settings.singleAgentSystemPrompt = String(single.systemPrompt || '');
        settings.singleAgentUserPromptTemplate = String(single.userPromptTemplate || '');
        await ctx.saveSettings?.();
        return;
    }
    if (scope === 'chat') {
        settings.chatOverrides[target.chatKey].agenda = { ...profile, enabled: true };
        await ctx.saveSettings?.();
        return;
    }
    if (scope === 'global') {
        const library = settings.presetLibraries?.[mode];
        if (!library?.[presetId]) throw new WriteError('target-gone', '要修改的方案已被删除');
        library[presetId] = { ...profile, name: library[presetId].name };
        await ctx.saveSettings?.();
        return;
    }
    // Character card: write the whole orchestrator block back through the
    // orchestrator's own persist helper (scoped to its extension key).
    const index = (ctx.characters || []).findIndex(c => String(c?.avatar || '') === String(target.avatar || ''));
    const ext = clone(index >= 0 ? ctx.characters[index]?.data?.extensions?.orchestrator : null);
    const library = ext?.presetLibraries?.[mode];
    if (!library?.[presetId]) throw new WriteError('target-gone', '角色卡上的方案已被删除');
    library[presetId] = { ...profile, name: library[presetId].name };
    const api = ctx.getExtensionApi?.('orchestrator');
    let ok = false;
    if (typeof api?.persistOrchestratorCharacterExtension === 'function') {
        ok = await api.persistOrchestratorCharacterExtension(ctx, index, ext);
    } else if (typeof ctx.writeExtensionField === 'function') {
        await ctx.writeExtensionField(index, 'orchestrator', ext);
        ok = true;
    }
    if (!ok) throw new WriteError('write', '写入角色卡失败');
}

/** Makes the native editor drop its cached drafts and redraw. */
async function refreshNativeEditor(ctx, settings) {
    try {
        const { editorState } = await loadModules();
        editorState?.initializeUiState?.(ctx);
    } catch { /* editor not loaded: nothing cached */ }
    const $ = globalThis.jQuery;
    if (!$) return;
    $('#luker_orch_single_agent_system_prompt').val(String(settings.singleAgentSystemPrompt || ''));
    $('#luker_orch_single_agent_user_prompt').val(String(settings.singleAgentUserPromptTemplate || ''));
    // Its change handler re-renders the agent panels (same mode → no switch).
    const select = $('#luker_orch_execution_mode');
    const mode = MODES.includes(String(settings.executionMode)) ? String(settings.executionMode) : 'spec';
    if (select.length) select.val(mode).trigger('change');
}

/**
 * @param {() => { ctx: object, settings: object }} host
 */
export function createProfileAccess(host) {
    return {
        /**
         * @param {object} target  snapshot.target { mode, scope, presetId, avatar, chatKey }
         * @param {object[]} changes  [{agentId, field, before, after}]
         * @param {{ force?: boolean }} opts  write even if some fields changed elsewhere
         * @returns {Promise<{ saved: boolean, conflicts: object[], missing: object[] }>}
         */
        async save(target, changes, { force = false } = {}) {
            const { ctx, settings } = host();
            const fresh = await readTarget(ctx, settings, target);
            const { profile, conflicts, missing } = mergeChanges(target.mode, fresh, changes);
            if (conflicts.length && !force) return { saved: false, conflicts, missing };
            await writeTarget(ctx, settings, target, profile);
            await refreshNativeEditor(ctx, settings);
            return { saved: true, conflicts, missing };
        },

        /** Connection profiles and generation presets to pick from. */
        async options() {
            const { ctx } = host();
            let connections = [];
            try {
                const resolver = await import('/scripts/extensions/connection-manager/profile-resolver.js');
                connections = (resolver.getChatCompletionConnectionProfiles?.() || []).map(p => String(p?.name || '')).filter(Boolean);
            } catch { connections = []; }
            let presets = [];
            try {
                const names = ctx.getPresetManager?.('openai')?.getAllPresets?.();
                presets = Array.isArray(names) ? [...new Set(names.map(n => String(n || '').trim()).filter(Boolean))] : [];
            } catch { presets = []; }
            return { connections, presets };
        },
    };
}

export function createAiAccess(host) {
    let runner = null;
    const loadRunner = () => {
        if (!runner) {
            runner = import('/scripts/iteration-library/runner.js').then((mod) => {
                if (typeof mod.requestToolCallsWithRetry !== 'function') throw new WriteError('ai-unsupported');
                return mod;
            }).catch((err) => {
                runner = null;
                throw err instanceof WriteError ? err : new WriteError('ai-unsupported', String(err?.message || err));
            });
        }
        return runner;
    };
    const lensSettings = (ctx) => {
        const all = ctx.extensionSettings || ctx.extension_settings || {};
        all[LENS_KEY] ||= {};
        all[LENS_KEY].ai ||= { api: '', preset: '' };
        return all[LENS_KEY].ai;
    };
    const readSessions = () => {
        try { return JSON.parse(globalThis.localStorage?.getItem(SESSIONS_KEY) || '{}') || {}; } catch { return {}; }
    };

    return {
        async check() {
            await loadRunner();
            return true;
        },

        /** { api, preset } chosen for the lens ('' = follow the orchestrator's 迭代 AI) + what that resolves to. */
        settings() {
            const { ctx, settings } = host();
            const own = lensSettings(ctx);
            return { api: String(own.api || ''), preset: String(own.preset || ''), orchApi: String(settings.requestApiPresetName || ''), orchPreset: String(settings.requestLlmPresetName || '') };
        },

        saveSettings({ api = '', preset = '' } = {}) {
            const { ctx } = host();
            Object.assign(lensSettings(ctx), { api: String(api), preset: String(preset) });
            ctx.saveSettingsDebounced?.();
        },

        /** One model call → { assistantText, reasoning, toolCalls: [{id,name,args}] }. */
        async request({ messages, tools, signal = null }) {
            const { ctx, settings } = host();
            const own = lensSettings(ctx);
            const { requestToolCallsWithRetry } = await loadRunner();
            const result = await requestToolCallsWithRetry(ctx, { toolCallRetryMax: settings.toolCallRetryMax, rpmLimit: settings.rpmLimit }, {
                taskMessages: messages,
                runtimeWorldInfo: null,
                apiPresetName: String(own.api || settings.requestApiPresetName || '').trim(),
                llmPresetName: String(own.preset || settings.requestLlmPresetName || '').trim(),
                tools,
                abortSignal: signal,
                includeAssistantText: true,
                allowNoToolCalls: true,
            });
            return {
                assistantText: String(result?.assistantText || ''),
                reasoning: String(result?.reasoning || ''),
                toolCalls: (Array.isArray(result?.toolCalls) ? result.toolCalls : []).map(call => ({
                    id: String(call?.id || ''),
                    name: String(call?.name || ''),
                    args: call?.args && typeof call.args === 'object' ? call.args : {},
                })),
            };
        },

        listSessions(scopeKey) {
            return clone(readSessions()[scopeKey] || []);
        },

        saveSessions(scopeKey, list) {
            const all = readSessions();
            all[scopeKey] = list;
            try {
                globalThis.localStorage?.setItem(SESSIONS_KEY, JSON.stringify(all));
            } catch {
                all[scopeKey] = list.slice(0, 3);
                try { globalThis.localStorage?.setItem(SESSIONS_KEY, JSON.stringify(all)); } catch { /* give up quietly */ }
            }
        },

        /** The reply the main model wrote right after a run's floor (same chat only). */
        replyFor(run) {
            try {
                const { ctx } = host();
                if (!run || Number(run.floor) < 0 || String(ctx.chatId || '') !== String(run.chatId || '')) return '';
                const chat = Array.isArray(ctx.chat) ? ctx.chat : [];
                for (let i = Number(run.floor) + 1; i < chat.length; i++) {
                    if (chat[i]?.is_user) return '';
                    if (!chat[i]?.is_system && chat[i]?.mes) return String(chat[i].mes);
                }
            } catch { /* host gone */ }
            return '';
        },
    };
}
