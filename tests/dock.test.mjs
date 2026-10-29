import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRunView } from '../src/model/run.js';
import { buildFlow } from '../src/model/profile.js';
import { createRecorder, createMemoryStorage } from '../src/model/recorder.js';
import { describeToolCall, previewText, segmentPreview } from '../src/model/describe.js';
import { buildBlocks, liveSummary, runCounts, currentBlock, blockLabel } from '../src/dock/dock-model.js';
import { createMockRunStore } from '../preview/mock-store.js';
import { PROFILES, scriptFor, searchScript, playScript, createClock } from '../preview/mock-data.js';

function setup() {
    const clock = createClock();
    const orch = createMockRunStore({ now: clock.now });
    const search = createMockRunStore({ now: clock.now });
    const recorder = createRecorder({ storage: createMemoryStorage(), now: clock.now });
    recorder.attach(orch, 'orchestrator');
    recorder.attach(search, 'search');
    return { clock, orch, search, recorder };
}

test('recorder follows two stores and tags runs with their source', () => {
    const { clock, orch, search, recorder } = setup();
    playScript(search, searchScript(), { speed: Infinity, clock });
    playScript(orch, scriptFor('loop'), { speed: Infinity, clock, stopAt: 4 });
    assert.equal(recorder.current().source, 'orchestrator', 'latest started wins');
    assert.deepEqual(recorder.currents().map(r => r.source), ['orchestrator', 'search']);
    assert.equal(recorder.isRunning(), true);
    assert.deepEqual(recorder.history().map(r => r.source), ['search']);
    recorder.attach(orch, 'orchestrator');
    assert.equal(recorder.currents().length, 2, 'attaching twice is a no-op');
});

test('search runs become one lane of numbered rounds', () => {
    const { clock, search, recorder } = setup();
    playScript(search, searchScript(), { speed: Infinity, clock });
    const view = buildRunView(recorder.history()[0]);
    assert.equal(view.mode, 'search');
    assert.deepEqual(view.lanes.map(l => l.agentId), ['search_agent']);
    const blocks = buildBlocks(view);
    assert.deepEqual(blocks.map(b => b.title), ['第 1 轮', '第 2 轮', '第 3 轮', '第 4 轮']);
    assert.equal(runCounts(view).tools, 3);
    const lines = segmentPreview(view.segments[0], 'search').lines.map(l => l.text);
    assert.deepEqual(lines, ['搜索网页「灯塔 灯油 历史 煤油」']);
});

test('spec blocks: stages in order, waiting agents and upcoming stages while running', () => {
    const { clock, orch, recorder } = setup();
    const script = scriptFor('spec');
    playScript(orch, script, { speed: Infinity, clock, stopAt: 8 }); // grounding: one node done, one still working
    const flow = buildFlow(PROFILES.spec, { mode: 'spec' });
    const view = buildRunView(recorder.current(), Object.keys(flow.agents));
    const blocks = buildBlocks(view, flow);
    assert.deepEqual(blocks.map(b => b.title), ['提炼', '定规矩', '规划', '审查', '汇总']);
    assert.equal(blocks[0].status, 'done');
    assert.equal(blocks[1].status, 'running');
    assert.equal(blocks[1].parallel, true);
    assert.ok(blocks.slice(2).every(b => b.upcoming && b.status === 'pending'));
    assert.match(liveSummary(view, flow), /^定规矩 · 2\/5$/);
});

test('spec rerun shows the replayed stage as its own block', () => {
    const { clock, orch, recorder } = setup();
    playScript(orch, scriptFor('spec', { rerun: true }), { speed: Infinity, clock });
    const flow = buildFlow(PROFILES.spec, { mode: 'spec' });
    const blocks = buildBlocks(buildRunView(recorder.history()[0]), flow);
    assert.ok(blocks.some(b => b.replay && b.title === '规划 · 重做'));
    assert.ok(!blocks.some(b => b.upcoming), 'finished runs list no upcoming stages');
});

test('director blocks nest sub-agents under the main round that dispatched them', () => {
    const { clock, orch, recorder } = setup();
    playScript(orch, scriptFor('director'), { speed: Infinity, clock });
    const blocks = buildBlocks(buildRunView(recorder.history()[0]));
    assert.equal(blocks.length, 3);
    assert.deepEqual(blocks[0].segments.map(s => s.agentId), ['main', 'chat_scout', 'memory_scout', 'epistemic_scout']);
    assert.deepEqual(blocks[1].segments.map(s => s.agentId), ['main', 'voice_critic', 'continuity_critic']);
    const mainLines = segmentPreview(blocks[0].segments[0], 'director').lines.map(l => l.text);
    assert.ok(mainLines.includes('派遣 聊天侦察'));
    assert.ok(mainLines.includes('等待 3 位助手'));
});

test('agenda blocks group dispatches under their planner round', () => {
    const { clock, orch, recorder } = setup();
    playScript(orch, scriptFor('agenda'), { speed: Infinity, clock });
    const blocks = buildBlocks(buildRunView(recorder.history()[0], ['distiller', 'lorebook_reader', 'planner', 'finalizer']));
    assert.deepEqual(blocks.map(b => b.title), ['第 1 轮调度', '第 2 轮调度', '第 3 轮调度', '收尾']);
    assert.deepEqual(blocks[0].segments.map(s => s.agentId), ['agenda_planner', 'distiller', 'lorebook_reader']);
    assert.equal(segmentPreview(blocks[0].segments[0], 'agenda').lines[0].text, '派出 场景提炼、世界书守门');
});

test('plain-language tool descriptions', () => {
    assert.equal(describeToolCall('luker_search_agent_visit', { url: 'https://www.example.com/a/b' }).text, '打开 example.com');
    assert.equal(describeToolCall('luker_search_agent_upsert_lorebook_entry', { title: '灯塔' }).text, '写入世界书「灯塔」');
    assert.equal(describeToolCall('apply_message_patches', '{"patches":[1,2]}').text, '修改正文 2 处');
    assert.equal(describeToolCall('chat_read_range', { from: 3, to: 9 }).text, '翻看第 3–9 楼');
    assert.equal(describeToolCall('something_new', {}).text, 'something new');
});

test('previewText strips yaml keys and bullets', () => {
    assert.equal(previewText('summary: 林栖在试探\ntension: 雾正在起\n- 第三条'), '林栖在试探 · 雾正在起 · 第三条');
    assert.equal(previewText(''), '');
    assert.ok(previewText('x'.repeat(500), { tail: true }).startsWith('…'));
});

test('floating window shows only the current round, and the next one replaces it', () => {
    const { clock } = setup();
    const script = scriptFor('loop');
    const shown = [];
    for (let stop = 2; stop <= script.steps.length; stop += 1) {
        const o = createMockRunStore({ now: clock.now });
        const rec = createRecorder({ storage: createMemoryStorage(), now: clock.now });
        rec.attach(o, 'orchestrator');
        playScript(o, script, { speed: Infinity, clock, stopAt: stop });
        const blocks = buildBlocks(buildRunView(rec.current()));
        const cur = currentBlock(blocks);
        if (cur && shown[shown.length - 1] !== cur.id) shown.push(cur.id);
    }
    assert.ok(shown.length > 1, 'moves on to later rounds');
    assert.equal(new Set(shown).size, shown.length, 'never goes back to an earlier round');
});

test('currentBlock skips upcoming stages; blockLabel names steps and rounds', () => {
    const { clock, orch, recorder } = setup();
    playScript(orch, scriptFor('spec'), { speed: Infinity, clock, stopAt: 6 });
    const flow = buildFlow(PROFILES.spec, { mode: 'spec' });
    const blocks = buildBlocks(buildRunView(recorder.current(), Object.keys(flow.agents)), flow);
    const cur = currentBlock(blocks);
    assert.ok(cur && !cur.upcoming);
    assert.match(blockLabel(cur).tag, /^第 \d+ 步$/);
    assert.deepEqual(blockLabel({ title: '第 2 轮' }), { tag: '第 2 轮', title: '' });
    assert.equal(currentBlock([]), null);
});
