// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Preview-only stand-ins for source.edit / source.ai: saves go to the
// in-memory profiles, and a scripted "model" reads an agent, proposes an
// edit, then answers in Chinese.

import { mergeChanges } from '../src/model/edit.js';

export function createMockEdit(getProfile, setProfile) {
    return {
        async save(target, changes, { force = false } = {}) {
            await new Promise(r => setTimeout(r, 150));
            const { profile, conflicts, missing } = mergeChanges(target.mode, getProfile(target.mode), changes);
            if (conflicts.length && !force) return { saved: false, conflicts, missing };
            setProfile(target.mode, profile);
            return { saved: true, conflicts, missing };
        },
        async options() {
            return { connections: ['Claude Sonnet', 'Claude Opus', 'Gemini Flash', 'DeepSeek'], presets: ['默认', '破限 · 长文', '分析专用'] };
        },
    };
}

export function createMockAi() {
    const store = {};
    let settings = { api: '', preset: '' };
    const pickAgent = (system) => {
        const ids = [...String(system).matchAll(/^- ([\w-]+)（/gm)].map(m => m[1]);
        return ids.find(id => /critic/.test(id)) || ids[1] || ids[0] || 'planner';
    };
    return {
        async check() { return true; },
        settings: () => ({ ...settings, orchApi: 'Claude Sonnet', orchPreset: '' }),
        saveSettings(next) { settings = { ...next }; },
        async request({ messages, signal }) {
            await new Promise((resolve, reject) => {
                const timer = setTimeout(resolve, 700);
                signal?.addEventListener('abort', () => { clearTimeout(timer); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); });
            });
            const system = messages[0].content;
            const diagnose = /这次的任务：诊断/.test(system);
            const tail = messages.slice(1);
            const lastUser = [...tail].reverse().find(m => m.role === 'user');
            const sinceUser = tail.slice(tail.lastIndexOf(lastUser) + 1);
            const toolTurns = sinceUser.filter(m => m.role === 'assistant').length;
            const agent = pickAgent(system);
            if (toolTurns === 0) {
                const calls = [{ id: `r${Date.now()}`, name: 'olens_read_agent', args: { agent_id: agent } }];
                if (diagnose) calls.unshift({ id: `s${Date.now()}`, name: 'olens_read_step', args: { step: 2 } });
                return { assistantText: '', toolCalls: calls };
            }
            if (toolTurns === 1) {
                const read = sinceUser.filter(m => m.role === 'tool').map(m => m.content).find(c => c.includes('"system"')) || '{}';
                let current = '';
                try { current = JSON.parse(read).system || ''; } catch { /* ignore */ }
                const first = current.split(/(?<=\.)\s/)[0] || current.slice(0, 40);
                return {
                    assistantText: '',
                    toolCalls: [{
                        id: `e${Date.now()}`,
                        name: 'olens_replace_text',
                        args: { agent_id: agent, field: 'system', old_text: first, new_text: `${first} Only send a stage back when a hard rule is broken; list minor issues as notes instead.` },
                    }],
                };
            }
            return {
                assistantText: diagnose
                    ? '结论：问题出在第 2 步「世界书守门」之后的审查环节，「审稿」把小问题也当成硬伤打回，导致规划重做了一次、整体慢了 8 秒。\n\n依据：\n· 审稿给出的打回理由是「节奏略快」，不属于硬规则；\n· 重做后的规划和第一次几乎一样。\n\n我改了「审稿」的角色设定：只有违反硬规则才打回，小问题写成备注交给汇总。'
                    : '我调整了「审稿」的角色设定：只在违反硬规则时打回，小问题改成备注，避免无谓的重做。其他助手的职责没有重叠，暂时不用改。',
                toolCalls: [],
            };
        },
        listSessions: (key) => JSON.parse(JSON.stringify(store[key] || [])),
        saveSessions: (key, list) => { store[key] = JSON.parse(JSON.stringify(list)); },
        replyFor: () => '雾从港口那边漫过来。温澜把灯油递给林栖，什么也没问。',
    };
}
