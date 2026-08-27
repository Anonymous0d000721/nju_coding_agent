import { describe, expect, it } from 'vitest';
import { clampThinkingLevel, cycleThinkingLevel, mappedThinkingValue, supportedThinkingLevels } from '../../src/model/thinking.js';

describe('thinking levels', () => {
  const map = { off: null, minimal: null, low: 'low', medium: 'med', high: 'high', max: 'xhigh' } as const;

  it('filters disabled levels and clamps to the nearest supported level', () => {
    expect(supportedThinkingLevels(map)).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(clampThinkingLevel('minimal', map)).toBe('low');
    expect(clampThinkingLevel('max', map)).toBe('max');
  });

  it('cycles only through supported levels and maps wire values', () => {
    expect(cycleThinkingLevel('low', map)).toBe('medium');
    expect(cycleThinkingLevel('max', map)).toBe('low');
    expect(mappedThinkingValue('medium', map)).toBe('med');
    expect(mappedThinkingValue('off', map)).toBeUndefined();
  });
});
