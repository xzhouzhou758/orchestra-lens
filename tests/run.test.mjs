import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRound, buildRunView, agentActivity, peakConcurrency, plannerDecision, toolNameOf, displayStatus, formatDuration } from '../src/model/run.js';
import { createRecorder, createMemoryStorage } from '../src/model/recorder.js';
import { createMockRunStore } from '../preview/mock-store.js';
import { scriptFor, playScript, createClock } from '../preview/mock-data.js';

function record(mode, options = {}) {
    const clock = createClock();
    const store = createMockRunStore({ now: clock.now });
    const storage = createMemoryStorage();
    const recorder = createRecorder({ storage, now: clock.now, wallNow: () => 1_700_000_000_000, getRunContext: () => ({ chatId: 'c1', floor: 3 }) });
    recorder.attach(store);
    const script = scriptFor(mode, options);
    playScript(store, script, { speed: Infinity, clock, stopAt: options.stopAt });
    return { store, recorder, storage, script };
}

test('parseRound understands every runtime id scheme', () => {
    assert.deepEqual(parseRound('spec', 'stage-reason-replay-1'), { agentId: '', stageId: 'reason', replay: true, attempt: 2, perSection: true });
    assert.equal(parseRound('agenda', 'node-agenda_planner-3').agentId, 'agenda_planner');
    assert.deepEqual(parseRound('agenda', 'node-lorebook_reader-lore-2', ['lorebook_reader']), { agentId: 'lorebook_reader', todo: 'lore', attempt: 2 });
    assert.equal(parseRound('agenda', 'node-my-agent-t-1', ['my-agent']).agentId, 'my-agent');
    assert.deepEqual(parseRound('agenda', 'node-finalizer-final'), { agentId: 'finalizer', final: true, attempt: 1 });
    assert.deepEqual(parseRound('loop', 'agent-4'), { agentId: 'loop_agent', attempt: 4 });
    assert.deepEqual(parseRound('director', 'main-0'), { agentId: 'main', attempt: 1 });
    assert.deepEqual(parseRound('director', 'sub-voice_critic-4'), { agentId: 'voice_critic', attempt: 4 });
});

test('spec run: one segment per node, parallel nodes overlap, replay marked', () => {
    const { recorder } = record('spec', { rerun: true });
    const view = buildRunView(recorder.history()[0]);
    assert.equal(view.status, 'committed');
    const lanes = Object.fromEntries(view.lanes.map(l => [l.agentId, l.segments]));
    assert.equal(lanes.planner.length, 2);
    assert.equal(lanes.planner[1].replay, true);
    const [a] = lanes.lorebook_reader;
    const [b] = lanes.anti_data_guard;
    assert.ok(a.start < b.end && b.start < a.end, 'grounding nodes run at the same time');
    assert.ok(a.duration > 0 && a.duration < b.duration, 'sections are timed individually');
    assert.ok(view.peakParallel >= 2);
    assert.ok(view.tokens > 0);
    assert.match(view.finalText, /写作指引/);
});

test('director run: sub-agents are separate lanes and overlap the main agent', () => {
    const { recorder } = record('director');
    const view = buildRunView(recorder.history()[0]);
    assert.deepEqual(view.lanes.map(l => l.agentId), ['main', 'chat_scout', 'memory_scout', 'epistemic_scout', 'voice_critic', 'continuity_critic']);
    assert.equal(view.lanes[0].segments.length, 3);
    assert.ok(view.peakParallel >= 3);
    const activity = agentActivity(view);
    assert.equal(activity.main.runs, 3);
    assert.equal(activity.chat_scout.status, 'done');
});

test('a run frozen mid-way is live: running segments extend to now', () => {
    const { recorder, script } = record('director', { stopAt: 30 });
    assert.ok(script.steps.length > 30);
    assert.equal(recorder.isRunning(), true);
    assert.equal(recorder.history().length, 0, 'unfinished runs are not saved');
    const view = buildRunView(recorder.current());
    const running = view.segments.filter(s => s.status === 'running');
    assert.ok(running.length >= 1);
    for (const seg of running) assert.equal(seg.end, view.duration);
    assert.equal(agentActivity(view).main.status, 'running');
});

test('recorder persists finished runs, newest first, and skips quiet runs', () => {
    const clock = createClock();
    const store = createMockRunStore({ now: clock.now });
    const storage = createMemoryStorage();
    const recorder = createRecorder({ storage, now: clock.now });
    recorder.attach(store);
    playScript(store, scriptFor('loop'), { speed: Infinity, clock });
    playScript(store, scriptFor('agenda'), { speed: Infinity, clock });
    const quiet = store.startRun({ mode: 'spec', quiet: true });
    store.finishRun({ runId: quiet, status: 'committed' });
    assert.deepEqual(recorder.history().map(r => r.mode), ['agenda', 'loop']);
    const again = createRecorder({ storage, now: clock.now });
    assert.equal(again.history().length, 2, 'history survives a reload');
    again.removeWhere(r => r.mode === 'loop');
    assert.deepEqual(again.history().map(r => r.mode), ['agenda']);
});

test('recorder keeps the first finish when director reports twice', () => {
    const clock = createClock();
    const store = createMockRunStore({ now: clock.now });
    const recorder = createRecorder({ storage: createMemoryStorage(), now: clock.now });
    recorder.attach(store);
    const runId = store.startRun({ mode: 'director' });
    store.finishRun({ runId, status: 'aborted', error: 'user_stopped' });
    store.finishRun({ runId, status: 'completed' });
    assert.equal(recorder.history().length, 1);
    assert.equal(recorder.history()[0].status, 'aborted');
});

test('stop calls the run stopFn; a stopped spec run reads as 已停止', () => {
    const clock = createClock();
    const store = createMockRunStore({ now: clock.now });
    const recorder = createRecorder({ storage: createMemoryStorage(), now: clock.now });
    recorder.attach(store);
    playScript(store, scriptFor('spec'), { speed: Infinity, clock, stopAt: 5 });
    assert.equal(recorder.stop(), true);
    const view = buildRunView(recorder.history()[0]);
    assert.equal(view.status, 'aborted');
    assert.equal(recorder.stop(), false);
});

test('agenda planner decisions and tool names are extracted', () => {
    const { recorder } = record('agenda');
    const run = recorder.history()[0];
    const planner = run.rounds.find(r => r.id === 'node-agenda_planner-1').sections[0];
    const decision = plannerDecision(planner);
    assert.equal(decision.dispatches.length, 2);
    assert.equal(decision.dispatches[0].agent, 'distiller');
    assert.equal(decision.finalize, false);
    assert.equal(toolNameOf({ title: 'Tool: chat_search' }), 'chat_search');
    assert.equal(toolNameOf({ title: '工具：lorebook_get' }), 'lorebook_get');
});

test('helpers', () => {
    assert.equal(displayStatus('error', 'Orchestration aborted.'), 'aborted');
    assert.equal(displayStatus('error', 'HTTP 500'), 'error');
    assert.equal(peakConcurrency([{ start: 0, end: 10 }, { start: 5, end: 15 }, { start: 10, end: 20 }]), 2);
    assert.equal(formatDuration(850), '850 毫秒');
    assert.equal(formatDuration(65000), '1 分 05 秒');
});
