import { cleanup } from '@testing-library/react';
import { parseHTML } from 'linkedom';

type Restorer = () => void;

const GLOBAL_KEYS = [
  'window',
  'document',
  'navigator',
  'HTMLElement',
  'Node',
  'Element',
  'DocumentFragment',
  'Text',
  'Event',
  'CustomEvent',
  'MouseEvent',
  'KeyboardEvent',
  'MutationObserver',
  'getComputedStyle',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'IS_REACT_ACT_ENVIRONMENT',
] as const;

export function installTestDom(): Restorer {
  const previous = new Map<PropertyKey, PropertyDescriptor | undefined>();
  for (const key of GLOBAL_KEYS) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  }

  const { window } = parseHTML('<!doctype html><html><body></body></html>');
  const raf = (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0) as unknown as number;
  const caf = (handle: number) => clearTimeout(handle);
  const getComputedStyle =
    typeof window.getComputedStyle === 'function'
      ? window.getComputedStyle.bind(window)
      : (() => ({}) as CSSStyleDeclaration);
  const MutationObserverImpl =
    window.MutationObserver ??
    class MutationObserver {
      observe() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    };

  Object.defineProperties(globalThis, {
    window: { configurable: true, writable: true, value: window },
    document: { configurable: true, writable: true, value: window.document },
    navigator: { configurable: true, writable: true, value: window.navigator },
    HTMLElement: { configurable: true, writable: true, value: window.HTMLElement },
    Node: { configurable: true, writable: true, value: window.Node },
    Element: { configurable: true, writable: true, value: window.Element },
    DocumentFragment: { configurable: true, writable: true, value: window.DocumentFragment },
    Text: { configurable: true, writable: true, value: window.Text },
    Event: { configurable: true, writable: true, value: window.Event },
    CustomEvent: { configurable: true, writable: true, value: window.CustomEvent },
    MouseEvent: { configurable: true, writable: true, value: window.MouseEvent },
    KeyboardEvent: { configurable: true, writable: true, value: window.KeyboardEvent },
    MutationObserver: { configurable: true, writable: true, value: MutationObserverImpl },
    getComputedStyle: { configurable: true, writable: true, value: getComputedStyle },
    requestAnimationFrame: { configurable: true, writable: true, value: raf },
    cancelAnimationFrame: { configurable: true, writable: true, value: caf },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, writable: true, value: true },
  });

  return () => {
    cleanup();
    for (const [key, descriptor] of previous.entries()) {
      if (descriptor) {
        Object.defineProperty(globalThis, key, descriptor);
      } else {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete (globalThis as Record<PropertyKey, unknown>)[key];
      }
    }
  };
}
