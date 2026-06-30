import { describe, expect, it, vi } from 'vitest';
import { MessageRouter } from '@/lib/message-router';

const sender = {} as chrome.runtime.MessageSender;

describe('MessageRouter', () => {
  it('ignores messages without a string type', () => {
    const router = new MessageRouter();
    const handler = vi.fn();
    router.on('A', handler);
    const sendResponse = vi.fn();

    expect(router.dispatch({}, sender, sendResponse)).toBeUndefined();
    expect(router.dispatch({ type: 42 }, sender, sendResponse)).toBeUndefined();
    expect(handler).not.toHaveBeenCalled();
    expect(sendResponse).not.toHaveBeenCalled();
  });

  it('ignores unknown types without responding', () => {
    const router = new MessageRouter();
    router.on('A', vi.fn());
    const sendResponse = vi.fn();

    expect(router.dispatch({ type: 'UNKNOWN' }, sender, sendResponse)).toBeUndefined();
    expect(sendResponse).not.toHaveBeenCalled();
  });

  it('responds synchronously for non-Promise handlers', () => {
    const router = new MessageRouter();
    router.on('A', () => ({ ok: true, value: 1 }));
    const sendResponse = vi.fn();

    const result = router.dispatch({ type: 'A' }, sender, sendResponse);

    expect(result).toBeUndefined();
    expect(sendResponse).toHaveBeenCalledWith({ ok: true, value: 1 });
  });

  it('keeps the port open and responds after the promise resolves', async () => {
    const router = new MessageRouter();
    router.on('A', async () => ({ ok: true }));
    const sendResponse = vi.fn();

    const result = router.dispatch({ type: 'A' }, sender, sendResponse);

    expect(result).toBe(true);
    expect(sendResponse).not.toHaveBeenCalled();
    await Promise.resolve();
    await Promise.resolve();
    expect(sendResponse).toHaveBeenCalledWith({ ok: true });
  });

  it('maps a rejected handler to the default error response', async () => {
    const router = new MessageRouter();
    router.on('A', async () => {
      throw new Error('boom');
    });
    const sendResponse = vi.fn();

    const result = router.dispatch({ type: 'A' }, sender, sendResponse);

    expect(result).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(sendResponse).toHaveBeenCalledWith({ ok: false, error: 'boom' });
  });

  it('maps a synchronous throw to the default error response', () => {
    const router = new MessageRouter();
    router.on('A', () => {
      throw new Error('sync boom');
    });
    const sendResponse = vi.fn();

    const result = router.dispatch({ type: 'A' }, sender, sendResponse);

    expect(result).toBeUndefined();
    expect(sendResponse).toHaveBeenCalledWith({ ok: false, error: 'sync boom' });
  });

  it('routes multiple registered types to the same handler', () => {
    const router = new MessageRouter();
    const handler = vi.fn(() => ({ ok: true }));
    router.on(['A', 'B'], handler);

    router.dispatch({ type: 'A' }, sender, vi.fn());
    router.dispatch({ type: 'B' }, sender, vi.fn());

    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('matches predicate routes and prefers exact routes', () => {
    const router = new MessageRouter();
    const exactHandler = vi.fn(() => 'exact');
    const predicateHandler = vi.fn(() => 'predicate');
    router.on('TEST_EXACT', exactHandler);
    router.onMatch((t) => t.startsWith('TEST_'), predicateHandler);

    const exactResponse = vi.fn();
    router.dispatch({ type: 'TEST_EXACT' }, sender, exactResponse);
    expect(exactResponse).toHaveBeenCalledWith('exact');
    expect(predicateHandler).not.toHaveBeenCalled();

    const predicateResponse = vi.fn();
    router.dispatch({ type: 'TEST_OTHER' }, sender, predicateResponse);
    expect(predicateResponse).toHaveBeenCalledWith('predicate');
  });

  it('uses a custom formatError when provided', () => {
    const router = new MessageRouter({ formatError: () => ({ custom: true }) });
    router.on('A', () => {
      throw new Error('boom');
    });
    const sendResponse = vi.fn();

    router.dispatch({ type: 'A' }, sender, sendResponse);

    expect(sendResponse).toHaveBeenCalledWith({ custom: true });
  });
});
