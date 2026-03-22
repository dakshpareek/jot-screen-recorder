import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RuntimeMessageType } from '@/lib/messages';

type RuntimeListener = (message: unknown) => void;

interface FakeElement {
  tagName: string;
  id: string;
  style: {
    cssText: string;
  };
  textContent: string;
  remove: () => void;
}

interface FakeDocument {
  documentElement: {
    appendChild: (element: FakeElement) => void;
  };
  head: {
    appendChild: (element: FakeElement) => void;
  };
  body: {
    appendChild: (element: FakeElement) => void;
  };
  getElementById: (id: string) => FakeElement | null;
  createElement: (tagName: string) => FakeElement;
}

function createFakeDocument(): FakeDocument {
  const byId = new Map<string, FakeElement>();

  const register = (element: FakeElement) => {
    if (element.id) byId.set(element.id, element);
  };

  const createContainer = () => ({
    appendChild: (element: FakeElement) => {
      register(element);
    },
  });

  return {
    documentElement: createContainer(),
    head: createContainer(),
    body: createContainer(),
    getElementById: (id: string) => byId.get(id) ?? null,
    createElement: (tagName: string) => {
      const element: FakeElement = {
        tagName,
        id: '',
        style: {
          cssText: '',
        },
        textContent: '',
        remove: () => {
          if (element.id) byId.delete(element.id);
        },
      };
      return element;
    },
  };
}

describe('content recording overlay', () => {
  let listeners: RuntimeListener[] = [];
  const addListenerMock = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    addListenerMock.mockReset();
    listeners = [];

    addListenerMock.mockImplementation((listener: RuntimeListener) => {
      listeners.push(listener);
    });

    (globalThis as { defineContentScript?: unknown }).defineContentScript = <T>(config: T) => config;
    (globalThis as { chrome?: unknown }).chrome = {
      runtime: {
        onMessage: {
          addListener: addListenerMock,
        },
      },
    };
    (globalThis as { document?: unknown }).document = createFakeDocument();
  });

  async function mountContentScript() {
    const mod = await import('@/entrypoints/content');
    const script = mod.default as { main: () => void };
    script.main();
    return listeners[0];
  }

  it('registers runtime listener on boot', async () => {
    await mountContentScript();
    expect(addListenerMock).toHaveBeenCalledTimes(1);
    expect(listeners).toHaveLength(1);
  });

  it('injects a single breathing overlay and shared keyframes style while recording', async () => {
    const listener = await mountContentScript();

    listener({
      type: RuntimeMessageType.RECORDING_BANNER,
      visible: true,
    });
    listener({
      type: RuntimeMessageType.RECORDING_BANNER,
      visible: true,
    });

    const documentRef = (globalThis as { document: FakeDocument }).document;
    const overlay = documentRef.getElementById('__screen_recorder_recording_overlay__');
    const style = documentRef.getElementById('__screen_recorder_recording_overlay_styles__');

    expect(overlay).not.toBeNull();
    expect(style).not.toBeNull();
    expect(overlay?.style.cssText).toContain('position: fixed');
    expect(overlay?.style.cssText).toContain('pointer-events: none');
    expect(overlay?.style.cssText).toContain('jot-recording-breathe');
    expect(style?.textContent).toContain('@keyframes jot-recording-breathe');
  });

  it('removes only the overlay when recording stops and ignores unrelated messages', async () => {
    const listener = await mountContentScript();

    listener({
      type: RuntimeMessageType.RECORDING_BANNER,
      visible: true,
    });
    listener({ type: 'UNRELATED_EVENT' });

    const documentRef = (globalThis as { document: FakeDocument }).document;
    expect(documentRef.getElementById('__screen_recorder_recording_overlay__')).not.toBeNull();
    expect(documentRef.getElementById('__screen_recorder_recording_overlay_styles__')).not.toBeNull();

    listener({
      type: RuntimeMessageType.RECORDING_BANNER,
      visible: false,
    });

    expect(documentRef.getElementById('__screen_recorder_recording_overlay__')).toBeNull();
    expect(documentRef.getElementById('__screen_recorder_recording_overlay_styles__')).not.toBeNull();
  });
});
