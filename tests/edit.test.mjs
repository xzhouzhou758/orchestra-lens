import test from 'node:test';
import assert from 'node:assert/strict';
import { listAgents, agentFields, getField, setField, replaceInField, diffProfiles, applyChanges, mergeChanges, invertChanges, validateField } from '../src/model/edit.js';
import { agentStats } from '../src/model/stats.js';
import { executeTools, runTurn, newSession, buildTaskMessages, systemPrompt, runSteps, diagnoseMessage, toolCallText, markEdits } from '../src/model/ai.js';
import { buildRunView } from '../src/model/run.js';
import { createRecorder, createMemoryStorage } from '../src/model/recorder.js';
import { createMockRunStore } from '../preview/mock-store.js';
import { PROFILES, scriptFor, playScript, createClock } from '../preview/mock-data.js';

test('fields per mode', () => {
    assert.deepEqual(listAgents('spec', PROFILES.spec), ['distiller', 'lorebook_reader', 'anti_data_guard', 'planner', 'recall_relevance', 'critic', 'synthesizer']);
    assert.deepEqual(agentFields('spec', PROFILES.spec, 'planner'), ['system', 'task', 'api', 'preset']);
    assert.deepEqual(agentFields('single', PROFILES.single, 'single_agent'), ['system', 'task']);
    assert.deepEqual(agentFields('loop', PROFILES.loop, 'loop_agent'), ['system', 'api', 'preset']);
    assert.deepEqual(agentFields('director', PROFILES.director, 'main'), ['system', 'api', 'preset']);
    assert.deepEqual(agentFields('director', PROFILES.director, 'chat_scout'), ['description', 'system', 'api', 'preset']);
    assert.deepEqual(listAgents('agenda', PROFILES.agenda)[0], 'agenda_planner');
    assert.equal(getField('spec', PROFILES.spec, 'planner', 'api'), 'Claude Sonnet');
    assert.equal(getField('loop', PROFILES.loop, 'loop_agent', 'system').startsWith('You are a single-agent'), true);
});

test('setField does not mutate and diff/apply round-trips', () => {
    const before = PROFILES.director;
    const after = setField('director', before, 'voice_critic', 'system', 'new voice');
    assert.notEqual(getField('director', before, 'voice_critic', 'system'), 'new voice');
    const changes = diffProfiles('director', before, after);
    assert.deepEqual(changes.map(c => c.id), ['voice_critic.system']);
    const applied = applyChanges('director', before, changes);
    assert.equal(getField('director', applied, 'voice_critic', 'system'), 'new voice');
    const undone = applyChanges('director', applied, invertChanges(changes));
    assert.deepEqual(diffProfiles('director', before, undone), []);
});

test('replaceInField needs one exact match', () => {
    const p = PROFILES.spec;
    const next = replaceInField('spec', p, 'critic', 'system', 'hard-gate critic', 'strict critic');
    assert.match(getField('spec', next, 'critic', 'system'), /strict critic/);
    assert.throws(() => replaceInField('spec', p, 'critic', 'system', 'nope', 'x'), /没有找到/);
    const twice = setField('spec', p, 'critic', 'system', 'a b a');
    assert.throws(() => replaceInField('spec', twice, 'critic', 'system', 'a', 'c'), /不止一次/);
});

test('mergeChanges keeps edits made elsewhere and flags conflicts', () => {
    const base = PROFILES.spec;
    const mine = diffProfiles('spec', base, setField('spec', base, 'planner', 'system', 'mine'));
    // Elsewhere: someone changed another agent and the same field.
    const elsewhere = setField('spec', setField('spec', base, 'distiller', 'system', 'native'), 'planner', 'system', 'theirs');
    const clean = mergeChanges('spec', setField('spec', base, 'distiller', 'system', 'native'), mine);
    assert.equal(clean.conflicts.length, 0);
    assert.equal(getField('spec', clean.profile, 'distiller', 'system'), 'native');
    assert.equal(getField('spec', clean.profile, 'planner', 'system'), 'mine');
    const clash = mergeChanges('spec', elsewhere, mine);
    assert.equal(clash.conflicts.length, 1);
    assert.equal(clash.conflicts[0].current, 'theirs');
});

test('director sub-agents need a system prompt', () => {
    assert.ok(validateField('director', 'chat_scout', 'system', '  '));
    assert.equal(validateField('director', 'main', 'system', ''), '');
});

test('AI tools run against a working copy', () => {
    const { profile, results } = executeTools([
        { id: 'a', name: 'olens_read_agent', args: { agent_id: 'critic' } },
        { id: 'b', name: 'olens_replace_text', args: { agent_id: 'critic', field: 'system', old_text: 'hard-gate critic', new_text: 'gentle critic' } },
        { id: 'c', name: 'olens_set_field', args: { agent_id: 'critic', field: 'api', value: 'Nope' } },
        { id: 'd', name: 'olens_set_field', args: { agent_id: 'ghost', field: 'system', value: 'x' } },
    ], { mode: 'spec', profile: PROFILES.spec, options: { connections: ['Claude Opus'], presets: [] } });
    assert.equal(results[0].ok, true);
    assert.ok(results[0].result.system);
    assert.equal(results[1].ok, true);
    assert.equal(results[2].ok, false);
    assert.match(results[2].result.error, /Claude Opus/);
    assert.equal(results[3].ok, false);
    assert.match(getField('spec', profile, 'critic', 'system'), /gentle critic/);
    assert.match(getField('spec', PROFILES.spec, 'critic', 'system'), /hard-gate/, 'input untouched');
    assert.equal(toolCallText({ name: 'olens_replace_text', args: { agent_id: 'critic', field: 'system' } }), '修改「审稿」的角色设定');
});

test('runTurn loops while the model calls tools and replays results', async () => {
    const seen = [];
    const replies = [
        { assistantText: '', toolCalls: [{ id: 't1', name: 'olens_set_field', args: { agent_id: 'planner', field: 'task', value: 'T' } }] },
        { assistantText: '改好了。', toolCalls: [] },
    ];
    const request = async ({ messages }) => { seen.push(messages); return replies.shift(); };
    const session = newSession();
    session.messages.push({ id: 'u', role: 'user', content: '改一下' });
    const out = await runTurn(request, session, { mode: 'spec', profile: PROFILES.spec, system: () => 'sys', tools: [] });
    assert.equal(out.rounds, 2);
    assert.equal(getField('spec', out.profile, 'planner', 'task'), 'T');
    assert.equal(session.messages.length, 3);
    const second = seen[1];
    assert.equal(second.at(-1).role, 'tool');
    assert.equal(second.at(-2).tool_calls[0].function.name, 'olens_set_field');
    markEdits(session.messages, [session.messages[1].id], { status: 'rolled_back' });
    assert.equal(buildTaskMessages('s', session.messages).find(m => m.role === 'tool').content, '{"status":"rolled_back"}');
});

function recorded(mode, opts = {}) {
    const clock = createClock();
    const store = createMockRunStore({ now: clock.now });
    const recorder = createRecorder({ storage: createMemoryStorage(), now: clock.now });
    recorder.attach(store, 'orchestrator');
    playScript(store, scriptFor(mode, opts), { speed: Infinity, clock });
    return recorder.history();
}

test('diagnosis prompt carries steps, final text and the profile', () => {
    const [raw] = recorded('spec', { rerun: true });
    const view = buildRunView(raw);
    const steps = runSteps(view);
    assert.ok(steps.length >= 6);
    assert.match(steps[0].short, /^1\. distiller（场景提炼）/);
    const msg = diagnoseMessage({ view, steps, focusStep: 2, complaint: '语气太冷' });
    assert.match(msg, /第 2 步/);
    assert.match(msg, /语气太冷/);
    assert.match(msg, /要诊断的这一步的完整过程/);
    const sys = systemPrompt({ mode: 'spec', profile: PROFILES.spec, diagnose: true });
    assert.match(sys, /诊断/);
    assert.match(sys, /critic（审稿）/);
    const read = executeTools([{ id: 'x', name: 'olens_read_step', args: { step: 1 } }], { mode: 'spec', profile: PROFILES.spec, steps });
    assert.match(read.results[0].result, /distiller/);
});

test('agent stats over history', () => {
    const runs = [...recorded('spec'), ...recorded('spec', { rerun: true })];
    const stats = agentStats(runs);
    assert.equal(stats.runs, 2);
    const planner = stats.agents.find(a => a.agentId === 'planner');
    assert.equal(planner.runs, 2);
    assert.ok(planner.steps >= 3, 'rerun adds a step');
    assert.ok(stats.agents.every(a => a.avg >= 0 && a.share <= 1));
    assert.ok(Math.abs(stats.agents.reduce((s, a) => s + a.share, 0) - 1) < 1e-9);
    assert.equal(agentStats(runs, { source: 'search' }).runs, 0);
});

import { createDrafts } from '../src/model/drafts.js';

test('drafts survive a reload that changed other fields, and drop saved ones', () => {
    const d = createDrafts();
    const target = { mode: 'spec', scope: 'global', presetId: 'default' };
    d.setBase(target, PROFILES.spec);
    d.set('critic', 'system', 'X');
    assert.equal(d.count(), 1);
    // Native editor saved another agent meanwhile.
    d.setBase(target, setField('spec', PROFILES.spec, 'planner', 'system', 'native'));
    assert.equal(d.count(), 1);
    assert.equal(getField('spec', d.profile(), 'planner', 'system'), 'native');
    assert.equal(getField('spec', d.profile(), 'critic', 'system'), 'X');
    // Our change got saved: the reload carries it, the draft is clean.
    d.setBase(target, setField('spec', PROFILES.spec, 'critic', 'system', 'X'));
    assert.equal(d.count(), 0);
    // Changes for another preset are kept, not applied.
    d.set('critic', 'task', 'T');
    d.setBase({ ...target, presetId: 'other' }, PROFILES.spec);
    assert.equal(d.isCurrent({ ...target, presetId: 'other' }), false);
    assert.equal(d.count(), 1);
    const snap = d.applyMany([{ agentId: 'critic', field: 'system', after: 'Y' }]);
    assert.equal(d.count(), 2);
    d.restore(snap);
    assert.equal(d.count(), 1);
});
