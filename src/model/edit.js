// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Agent-level editing of an orchestrator profile, shared by hand edits and
// the AI assistant. Only per-agent text and model routing are editable here;
// adding / removing agents or stages stays in the native editor.
//
// Fields (display keys):
//   system       角色设定（系统提示词）
//   task         任务模板（user prompt template）
//   description  说明（director sub-agents only）
//   api          连接配置   preset  生成预设
//
// Where each one lives depends on the mode (see locate()). Pure: no DOM.

export const FIELD_LABELS = { system: '角色设定', task: '任务模板', description: '说明', api: '连接配置', preset: '生成预设' };
export const TEXT_FIELDS = ['system', 'task', 'description'];

const obj = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : null);
const str = (value) => (value == null ? '' : String(value));

export function cloneProfile(profile) {
    return profile == null ? profile : JSON.parse(JSON.stringify(profile));
}

function specNodes(profile) {
    const stages = Array.isArray(profile?.spec?.stages) ? profile.spec.stages : [];
    const out = [];
    stages.forEach((stage, si) => (Array.isArray(stage?.nodes) ? stage.nodes : []).forEach((node, ni) => {
        const id = typeof node === 'string' ? node : str(node?.id || node?.preset);
        if (id) out.push({ id, stage: si, index: ni, node });
    }));
    return out;
}

/** Agent ids in display order. */
export function listAgents(mode, profile) {
    const p = obj(profile) || {};
    if (mode === 'spec' || mode === 'single') return specNodes(p).map(n => n.id);
    if (mode === 'agenda') return ['agenda_planner', ...Object.keys(obj(p.agents) || {})];
    if (mode === 'loop') return ['loop_agent'];
    if (mode === 'director') return ['main', ...(Array.isArray(p.subAgents) ? p.subAgents : []).map(a => str(a?.id)).filter(Boolean)];
    return [];
}

/**
 * field → { obj, key } inside `profile` (the live object, so callers mutate a
 * clone). `create` makes the holder when it is missing (spec preset entries).
 */
function locate(mode, profile, agentId, { create = false } = {}) {
    const p = obj(profile);
    if (!p) return {};
    const id = str(agentId);
    const entry = (holder, keys) => Object.fromEntries(Object.entries(keys).map(([field, key]) => [field, holder ? { obj: holder, key } : null]).filter(([, v]) => v));
    const routing = { system: 'systemPrompt', task: 'userPromptTemplate', api: 'apiPresetName', preset: 'promptPresetName' };

    if (mode === 'spec' || mode === 'single') {
        const hit = specNodes(p).find(n => n.id === id);
        if (!hit) return {};
        const presetId = typeof hit.node === 'string' ? hit.node : str(hit.node?.preset || hit.node?.id);
        if (create) {
            p.presets = obj(p.presets) || {};
            p.presets[presetId] = obj(p.presets[presetId]) || {};
        }
        const preset = obj(p.presets?.[presetId]);
        const keys = mode === 'single' ? { system: 'systemPrompt', task: 'userPromptTemplate' } : routing;
        const out = entry(preset, keys);
        // A node-level template overrides the preset's one.
        if (out.task && typeof hit.node === 'object' && str(hit.node.userPromptTemplate).trim()) out.task = { obj: hit.node, key: 'userPromptTemplate' };
        return out;
    }
    if (mode === 'agenda') {
        const holder = id === 'agenda_planner' ? obj(p.planner) : obj(p.agents?.[id]);
        return entry(holder, routing);
    }
    if (mode === 'loop') {
        return id === 'loop_agent' ? entry(p, { system: 'system_prompt', api: 'apiPresetName', preset: 'promptPresetName' }) : {};
    }
    if (mode === 'director') {
        if (id === 'main') return entry(obj(p.mainAgent), { system: 'systemPrompt', api: 'apiPresetName', preset: 'promptPresetName' });
        const sub = (Array.isArray(p.subAgents) ? p.subAgents : []).find(a => str(a?.id) === id);
        return entry(obj(sub), { description: 'description', system: 'systemPrompt', api: 'apiPresetName', preset: 'promptPresetName' });
    }
    return {};
}

/** Editable fields for one agent, in display order. */
export function agentFields(mode, profile, agentId) {
    const found = locate(mode, profile, agentId);
    return ['description', 'system', 'task', 'api', 'preset'].filter(field => found[field]);
}

export function getField(mode, profile, agentId, field) {
    const slot = locate(mode, profile, agentId)[field];
    return slot ? str(slot.obj[slot.key]) : '';
}

/** Returns a new profile with one field changed (the input is untouched). */
export function setField(mode, profile, agentId, field, value) {
    const next = cloneProfile(profile);
    const slot = locate(mode, next, agentId, { create: true })[field];
    if (!slot) throw new EditError('field', `「${agentId}」没有「${FIELD_LABELS[field] || field}」`);
    slot.obj[slot.key] = str(value);
    return next;
}

export class EditError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}

/**
 * Replaces one exact occurrence of `oldText` in a text field.
 * Throws EditError('not_found' | 'ambiguous').
 */
export function replaceInField(mode, profile, agentId, field, oldText, newText) {
    const current = getField(mode, profile, agentId, field);
    const needle = str(oldText);
    if (!needle) throw new EditError('empty', 'old_text 不能为空');
    const first = current.indexOf(needle);
    if (first < 0) throw new EditError('not_found', '没有找到这段原文（请先读取原文，逐字照抄要替换的部分）');
    if (current.indexOf(needle, first + needle.length) >= 0) throw new EditError('ambiguous', '这段原文出现了不止一次，请多带一些上下文');
    return setField(mode, profile, agentId, field, current.slice(0, first) + str(newText) + current.slice(first + needle.length));
}

/** Checks the orchestrator would accept the value (its sanitizers drop some empties). */
export function validateField(mode, agentId, field, value) {
    if (mode === 'director' && agentId !== 'main' && field === 'system' && !str(value).trim()) {
        return '导演模式的助手必须有角色设定，留空会被编排器删除';
    }
    return '';
}

/**
 * Field-level differences between two versions of the same profile.
 * @returns {{ id: string, agentId: string, field: string, before: string, after: string }[]}
 */
export function diffProfiles(mode, before, after) {
    const ids = [...new Set([...listAgents(mode, before), ...listAgents(mode, after)])];
    const out = [];
    for (const agentId of ids) {
        const fields = new Set([...agentFields(mode, before, agentId), ...agentFields(mode, after, agentId)]);
        for (const field of ['description', 'system', 'task', 'api', 'preset']) {
            if (!fields.has(field)) continue;
            const a = getField(mode, before, agentId, field);
            const b = getField(mode, after, agentId, field);
            if (a !== b) out.push({ id: `${agentId}.${field}`, agentId, field, before: a, after: b });
        }
    }
    return out;
}

/** Copies the chosen changes' `after` values onto `base`. */
export function applyChanges(mode, base, changes) {
    let next = cloneProfile(base);
    for (const change of changes) next = setField(mode, next, change.agentId, change.field, change.after);
    return next;
}

/**
 * Puts the changes on top of the freshly stored profile so edits made
 * elsewhere (the native editor) to other fields survive. A field that was
 * also changed elsewhere since the draft started is a conflict.
 * @returns {{ profile: object, conflicts: object[], missing: object[] }}
 */
export function mergeChanges(mode, fresh, changes) {
    let profile = cloneProfile(fresh);
    const conflicts = [];
    const missing = [];
    for (const change of changes) {
        if (!agentFields(mode, profile, change.agentId).includes(change.field)) {
            missing.push(change);
            continue;
        }
        const now = getField(mode, profile, change.agentId, change.field);
        if (now !== change.before && now !== change.after) conflicts.push({ ...change, current: now });
        profile = setField(mode, profile, change.agentId, change.field, change.after);
    }
    return { profile, conflicts, missing };
}

/** The same changes, undone (after ↔ before). */
export function invertChanges(changes) {
    return changes.map(c => ({ ...c, before: c.after, after: c.before }));
}

/** Agent ids that differ between two profiles. */
export function changedAgents(mode, before, after) {
    return new Set(diffProfiles(mode, before, after).map(c => c.agentId));
}
