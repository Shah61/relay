import { Codex } from './protocol.ts';
export type Model = {
  model: string; displayName: string; isDefault: boolean;
  defaultReasoningEffort: string;
  supportedReasoningEfforts: { reasoningEffort: string; description: string }[];
};
export async function listModels(rpc: Pick<Codex, 'request'>): Promise<Model[]> {
  const models: Model[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 20; page++) {
    const result = await rpc.request('model/list', { limit: 100, includeHidden: false, cursor });
    if (!Array.isArray(result.data)) throw Error('Codex returned an invalid model catalog');
    for (const m of result.data) {
      if (m.hidden || typeof m.model !== 'string') continue;
      models.push({ model: m.model, displayName: m.displayName || m.model,
        isDefault: m.isDefault === true, defaultReasoningEffort: m.defaultReasoningEffort,
        supportedReasoningEfforts: Array.isArray(m.supportedReasoningEfforts) ? m.supportedReasoningEfforts : [] });
    }
    if (!result.nextCursor) {
      if (!models.length) throw Error('Codex returned no models. Check its installation and sign-in.');
      return models;
    }
    if (result.nextCursor === cursor) throw Error('Invalid Codex model pagination');
    cursor = result.nextCursor;
  }
  throw Error('Codex model catalog exceeded page limit');
}
export function selectModel(models: Model[], model?: string, effort?: string) {
  const selected = model ? models.find(m => m.model === model) : models.find(m => m.isDefault) ?? models[0];
  if (!selected) throw Error('Model is not in this computer’s Codex catalog. Refresh and choose another model.');
  const reasoningEffort = effort ?? selected.defaultReasoningEffort;
  if (!selected.supportedReasoningEfforts.some(e => e.reasoningEffort === reasoningEffort))
    throw Error('Reasoning effort is not supported by the selected model');
  return { model: selected.model, reasoningEffort };
}
const cache = new Map<string, { expires: number; value: Promise<Model[]> }>();
export function discoverModels(executable: string) {
  const previous = cache.get(executable);
  if (previous && previous.expires > Date.now()) return previous.value;
  const value = (async () => {
    const rpc = new Codex({}, executable);
    try { await rpc.initialize(); return await listModels(rpc); }
    finally { rpc.close(); }
  })();
  cache.set(executable, { expires: Date.now() + 60000, value });
  void value.catch(() => cache.delete(executable));
  return value;
}
