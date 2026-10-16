import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFlow, enabledTools } from '../src/model/profile.js';
import { PROFILES } from '../preview/mock-data.js';
import { agentName, toolName, humanizeId } from '../src/i18n.js';

test('spec: one column per stage, parallel flag, review forces serial', () => {
    const flow = buildFlow(PROFILES.spec, { mode: 'spec' });
    assert.deepEqual(flow.columns.map(c => c.id), ['distill', 'grounding', 'reason', 'review', 'finalize']);
    assert.equal(flow.columns[1].parallel, true);
    assert.equal(flow.columns[3].review, true);
    assert.equal(flow.columns[3].parallel, false);
    assert.equal(flow.columns.at(-1).final, true);
    assert.equal(flow.agents.critic.kind, 'review');
    assert.equal(flow.agents.lorebook_reader.apiPreset, 'Gemini Flash');
    assert.match(flow.agents.distiller.userPrompt, /recent_chat/);
    assert.equal(flow.output, 'capsule');
});

test('spec: node-level template and tools override the preset', () => {
    const flow = buildFlow({
        spec: { stages: [{ id: 's', mode: 'parallel', nodes: [{ id: 'a', preset: 'p', userPromptTemplate: 'custom', tools: { chat: { search: true } } }, 'p'] }] },
        presets: { p: { systemPrompt: 'sys', userPromptTemplate: 'base' } },
    }, { mode: 'spec' });
    assert.equal(flow.agents.a.userPrompt, 'custom');
    assert.deepEqual(flow.agents.a.tools, ['chat_search']);
    assert.equal(flow.agents.p.userPrompt, 'base');
    assert.equal(flow.agents.p.tools, null);
});

test('agenda: planner, pool without the final agent, final column', () => {
    const flow = buildFlow(PROFILES.agenda, { mode: 'agenda' });
    assert.deepEqual(flow.columns.map(c => c.kind), ['driver', 'pool', 'stage']);
    assert.ok(!flow.columns[1].nodes.includes('finalizer'));
    assert.deepEqual(flow.columns[2].nodes, ['finalizer']);
    assert.deepEqual(flow.limits.map(l => l.key), ['limitRounds', 'limitConcurrent', 'limitTotal']);
});

test('loop: single agent with flattened tools', () => {
    const flow = buildFlow(PROFILES.loop, { mode: 'loop' });
    const tools = flow.agents.loop_agent.tools;
    assert.ok(tools.includes('chat_search'));
    assert.ok(tools.includes('memory_search'));
    assert.ok(tools.includes('finalize'));
    assert.ok(!tools.includes('lorebook_list'), 'disabled flags are skipped');
    assert.equal(flow.limits.find(l => l.key === 'limitTime').value, 300);
});

test('director: main + grouped team, body output, inherited tools', () => {
    const flow = buildFlow(PROFILES.director, { mode: 'director' });
    assert.equal(flow.output, 'body');
    assert.equal(flow.columns[0].id, 'main');
    const groups = Object.fromEntries(flow.columns.slice(1).map(c => [c.id, c.nodes]));
    assert.ok(groups.scout.includes('chat_scout'));
    assert.deepEqual(groups.critic, ['voice_critic', 'continuity_critic']);
    assert.deepEqual(flow.agents.epistemic_scout.inheritedTools, ['chat_read_range']);
});

test('director: unknown sub-agent ids go to the other group, duplicates dropped', () => {
    const flow = buildFlow({ mainAgent: {}, subAgents: [{ id: '我的助手', systemPrompt: 'x' }, { id: '我的助手', systemPrompt: 'y' }, { id: '', systemPrompt: 'z' }] }, { mode: 'director' });
    assert.deepEqual(flow.columns.find(c => c.id === 'other').nodes, ['我的助手']);
});

test('empty / garbage profiles do not throw', () => {
    for (const mode of ['spec', 'single', 'agenda', 'loop', 'director']) {
        assert.doesNotThrow(() => buildFlow(null, { mode }));
        assert.doesNotThrow(() => buildFlow({ spec: { stages: 'x' }, agents: 5, subAgents: {} }, { mode }));
    }
});

test('enabledTools flattens flag trees', () => {
    assert.deepEqual(enabledTools({ chat: { read_range: true, search: false }, custom: { memory_get: true }, finalize: true }), ['chat_read_range', 'memory_get', 'finalize']);
    assert.deepEqual(enabledTools(null), []);
});

test('display names: shipped ids are Chinese, user ids pass through', () => {
    assert.equal(agentName('distiller'), '场景提炼');
    assert.equal(agentName('林栖的助手'), '林栖的助手');
    assert.equal(humanizeId('my_custom-agent'), 'my custom agent');
    assert.equal(toolName('chat_search'), '搜索聊天');
    assert.equal(toolName('memory_search'), '搜索记忆');
    assert.equal(toolName('lorebook_whatever'), '世界书工具');
});
