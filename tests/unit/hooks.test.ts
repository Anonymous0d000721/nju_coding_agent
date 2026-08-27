import { describe, expect, it } from 'vitest';
import { HookRegistry } from '../../src/agent/hooks.js';

describe('HookRegistry', () => {
  it('runs registered hooks in registration order', async () => {
    const events: string[] = [];
    const hooks = new HookRegistry();
    hooks.register({ beforeRun: async () => { events.push('first'); } });
    hooks.register({ beforeRun: async () => { events.push('second'); } });

    await hooks.run('beforeRun', { userPrompt: 'test', turn: 0 });

    expect(events).toEqual(['first', 'second']);
  });

  it('propagates hook failures so the host can stop the run', async () => {
    const hooks = new HookRegistry();
    hooks.register({ beforeTool: () => { throw new Error('blocked'); } });

    await expect(hooks.run('beforeTool', { userPrompt: 'test', turn: 0 })).rejects.toThrow('blocked');
  });
});
