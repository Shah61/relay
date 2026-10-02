import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listModels, selectModel } from '../src/codex/models.ts';
test('Codex catalog paginates, excludes hidden models, and validates model/effort pairs', async () => {
  const model = (name: string, isDefault = false) => ({ model: name, displayName: name, isDefault, defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: '' }, { reasoningEffort: 'high', description: '' }] });
  const calls: any[] = [];
  const models = await listModels({ async request(method, params) {
    calls.push({method, params});
    return params.cursor ? {data:[model('second', true)], nextCursor:null} : {data:[model('first'), {...model('hidden'),hidden:true}],nextCursor:'page2'};
  }});
  assert.equal(calls.length, 2);
  assert.equal(calls[1].params.cursor, 'page2');
  assert.deepEqual(models.map(m => m.model), ['first','second']);
  assert.deepEqual(selectModel(models), {model:'second',reasoningEffort:'medium'});
  assert.deepEqual(selectModel(models,'first','high'), {model:'first',reasoningEffort:'high'});
  assert.throws(() => selectModel(models,'unlisted','high'));
  assert.throws(() => selectModel(models,'first','ultra'));
  await assert.rejects(() => listModels({async request(){return {data:[],nextCursor:null}}}));
});
