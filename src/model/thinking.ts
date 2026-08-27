import type { ThinkingLevel, ThinkingLevelMap } from './model-client.js';

export const THINKING_LEVELS: readonly ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

export function supportedThinkingLevels(map?: ThinkingLevelMap): ThinkingLevel[] {
  return THINKING_LEVELS.filter((level) => map?.[level] !== null);
}

export function clampThinkingLevel(level: ThinkingLevel, map?: ThinkingLevelMap): ThinkingLevel {
  const supported = supportedThinkingLevels(map);
  if (supported.includes(level)) return level;
  const requested = THINKING_LEVELS.indexOf(level);
  return supported.reduce((best, candidate) =>
    Math.abs(THINKING_LEVELS.indexOf(candidate) - requested) < Math.abs(THINKING_LEVELS.indexOf(best) - requested) ? candidate : best,
    supported[0] ?? 'off',
  );
}

export function cycleThinkingLevel(level: ThinkingLevel, map?: ThinkingLevelMap): ThinkingLevel {
  const supported = supportedThinkingLevels(map);
  if (supported.length === 0) return 'off';
  const index = supported.indexOf(clampThinkingLevel(level, map));
  return supported[(index + 1) % supported.length];
}

export function mappedThinkingValue(level: ThinkingLevel, map?: ThinkingLevelMap): string | undefined {
  const value = map?.[level];
  return value === null ? undefined : value ?? (level === 'off' ? undefined : level);
}
