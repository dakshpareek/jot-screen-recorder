type Sender = chrome.runtime.MessageSender;
type SendResponse = (response?: unknown) => void;
type Handler = (message: any, sender: Sender) => unknown | Promise<unknown>;

interface MessageRouterOptions {
  /** Formats an uncaught handler rejection into a response payload. */
  formatError?: (error: unknown) => unknown;
}

const defaultFormatError = (error: unknown) => ({
  ok: false,
  error:
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : 'Unknown error',
});

export class MessageRouter {
  private exact = new Map<string, Handler>();
  private predicates: Array<{ match: (type: string) => boolean; handler: Handler }> = [];
  private formatError: (error: unknown) => unknown;

  constructor(options: MessageRouterOptions = {}) {
    this.formatError = options.formatError ?? defaultFormatError;
  }

  on(type: string | string[], handler: Handler): this {
    for (const t of Array.isArray(type) ? type : [type]) this.exact.set(t, handler);
    return this;
  }

  onMatch(match: (type: string) => boolean, handler: Handler): this {
    this.predicates.push({ match, handler });
    return this;
  }

  /** Bind once: chrome.runtime.onMessage.addListener(router.dispatch) */
  dispatch = (message: unknown, sender: Sender, sendResponse: SendResponse): boolean | void => {
    const type = (message as { type?: unknown })?.type;
    if (typeof type !== 'string') return; // no-type guard → ignore

    const handler =
      this.exact.get(type) ?? this.predicates.find((p) => p.match(type))?.handler;
    if (!handler) return; // unknown type → ignore, no response

    let result: unknown;
    try {
      result = handler(message, sender);
    } catch (error) {
      sendResponse(this.formatError(error)); // sync throw
      return;
    }

    if (result instanceof Promise) {
      result.then(sendResponse).catch((e) => sendResponse(this.formatError(e)));
      return true; // async → keep port open
    }
    sendResponse(result); // sync responder
    return; // matches GET_STATE-style branches
  };
}
