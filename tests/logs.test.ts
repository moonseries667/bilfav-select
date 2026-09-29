import { describe, expect, it } from 'vitest';
import { Logger } from '../src/lib/logs';
import type { DiagnosticEvent } from '../src/types';

describe('persistent detailed diagnostics', () => {
  it('keeps batching writes after the cap and preserves the newest events across reload', () => {
    const initial = Array.from({ length: 4995 }, (_, index) => ({ task: 'refresh', phase: 'metadata', message: `old-${index}` }));
    let persisted: DiagnosticEvent[] = [];
    let truncated = false;
    let writes = 0;
    const logger = new Logger(() => [], (events, cut) => {
      persisted = structuredClone(events); truncated = cut; writes++;
    }, initial);
    for (let index = 0; index < 30; index++) logger.diagnostic({ task: 'refresh', phase: 'metadata', message: `new-${index}` });
    expect(writes).toBe(1);
    logger.flush();
    expect(writes).toBe(2);
    expect(persisted).toHaveLength(5000);
    expect(persisted[0].message).toBe('old-25');
    expect(persisted.at(-1)?.message).toBe('new-29');
    const reloaded = new Logger(() => [], undefined, persisted, truncated).exportDetailed();
    expect(reloaded.truncated).toBe(true);
    expect(reloaded.events.at(-1)?.message).toBe('new-29');
  });

  it.each(['failed', 'paused', 'completed'])('flushes the final partial batch on %s', outcome => {
    let persisted: DiagnosticEvent[] = [];
    const logger = new Logger(() => [], events => { persisted = structuredClone(events); });
    logger.diagnostic({ task: 'freeze', phase: 'start', outcome: 'started' });
    expect(persisted).toHaveLength(0);
    logger.diagnostic({ task: 'freeze', phase: 'freezing', outcome });
    expect(persisted).toHaveLength(2);
    expect(persisted[1].outcome).toBe(outcome);
  });

  it('flushes pending events on export and redacts their content before persistence', () => {
    const key = 'fixture-private-key';
    let persisted: DiagnosticEvent[] = [];
    const logger = new Logger(() => [key], events => { persisted = structuredClone(events); });
    logger.diagnostic({ task: 'models', phase: 'model-list', reason: `echo ${key}; Cookie=fixture-cookie` });
    expect(persisted).toHaveLength(0);
    const output = logger.exportDetailed();
    expect(output.events).toEqual(persisted);
    expect(output.events).toHaveLength(1);
    expect(JSON.stringify(output)).not.toContain(key);
    expect(JSON.stringify(persisted)).not.toContain('fixture-cookie');
  });
});
