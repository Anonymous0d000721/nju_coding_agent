import type { AssistantTurn } from '../agent/types.js';
import type { ModelClient, ModelRequest } from './model-client.js';

export interface ModelRetryEvent {
  attempt: number;
  nextAttempt: number;
  delayMs: number;
  elapsedMs: number;
  status?: number;
  reason: string;
}

export interface ModelRetryOptions {
  maxAttempts?: number;
  maxElapsedMs?: number;
  requestTimeoutMs?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  random?: () => number;
  onRetry?: (event: ModelRetryEvent) => void | Promise<void>;
  canRetry?: (error: ModelTransportError) => boolean;
}

export class ModelTransportError extends Error {
  readonly retryable: boolean;
  readonly status?: number;
  readonly retryAfterMs?: number;
  readonly code: string;

  constructor(message: string, options: { code?: string; retryable?: boolean; status?: number; retryAfterMs?: number } = {}) {
    super(message);
    this.name = 'ModelTransportError';
    this.code = options.code ?? 'model_transport_error';
    this.retryable = options.retryable ?? false;
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
  }
}

export async function withModelRetry<T>(operation: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal, options: ModelRetryOptions = {}): Promise<T> {
  const maxAttempts = clampInteger(options.maxAttempts ?? 3, 1, 10);
  const maxElapsedMs = Math.max(1, options.maxElapsedMs ?? 120_000);
  const requestTimeoutMs = Math.max(1, options.requestTimeoutMs ?? 30_000);
  const baseDelayMs = Math.max(0, options.baseDelayMs ?? 250);
  const maxDelayMs = Math.max(baseDelayMs, options.maxDelayMs ?? 10_000);
  const random = options.random ?? Math.random;
  const started = Date.now();

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (signal?.aborted) throw abortError(signal);
    try {
      return await runAttempt(operation, signal, requestTimeoutMs);
    } catch (error) {
      if (signal?.aborted) throw abortError(signal);
      const transport = normalizeTransportError(error);
      if (options.canRetry && !options.canRetry(transport)) throw transport;
      const elapsedMs = Date.now() - started;
      if (!transport.retryable || attempt >= maxAttempts) throw transport;
      const exponential = Math.min(maxDelayMs, baseDelayMs * (2 ** (attempt - 1)));
      const jittered = Math.round(exponential * (0.5 + Math.min(1, Math.max(0, random()))));
      const delayMs = Math.max(0, transport.retryAfterMs ?? jittered);
      if (elapsedMs + delayMs >= maxElapsedMs) throw new ModelTransportError('Model retry wall-clock limit exceeded', { code: 'model_retry_timeout', retryable: false });
      await options.onRetry?.({ attempt, nextAttempt: attempt + 1, delayMs, elapsedMs, status: transport.status, reason: transport.code });
      await sleep(delayMs, signal);
    }
  }
  throw new ModelTransportError('Model retry exhausted', { code: 'model_retry_exhausted' });
}

export function withRetryingModelClient(client: ModelClient, options: ModelRetryOptions = {}): ModelClient {
  const wrapped: ModelClient = {
    complete: (request: ModelRequest, signal?: AbortSignal): Promise<AssistantTurn> => withModelRetry((attemptSignal) => client.complete(request, attemptSignal), signal, options),
  };
  if (client.stream) {
    wrapped.stream = (request, handler, signal) => {
      let emitted = false;
      return withModelRetry((attemptSignal) => client.stream!(request, async (event) => {
        if (event.type !== 'done') emitted = true;
        await handler?.(event);
      }, attemptSignal), signal, {
        ...options,
        canRetry: (error) => !emitted && (options.canRetry?.(error) ?? true),
      });
    };
  }
  return wrapped;
}

export function modelError(response: Response): ModelTransportError {
  const status = response.status;
  const retryable = status === 429 || status >= 500;
  return new ModelTransportError(`Model request failed: HTTP ${status} ${response.statusText}`, {
    code: `http_${status}`,
    retryable,
    status,
    retryAfterMs: parseRetryAfter(response.headers.get('retry-after')),
  });
}

function normalizeTransportError(error: unknown): ModelTransportError {
  if (error instanceof ModelTransportError) return error;
  if (isAbortError(error)) return new ModelTransportError('Model request timed out', { code: 'model_timeout', retryable: true });
  if (error instanceof Error && (error as Error & { retryable?: boolean }).retryable) {
    return new ModelTransportError(error.message, { code: error.name || 'model_transport_error', retryable: true });
  }
  if (error instanceof TypeError) return new ModelTransportError(error.message || 'Model network request failed', { code: 'network_error', retryable: true });
  if (error instanceof Error) return new ModelTransportError(error.message, { code: 'model_response_error', retryable: false });
  return new ModelTransportError(String(error), { code: 'model_response_error', retryable: false });
}

async function runAttempt<T>(operation: (signal: AbortSignal) => Promise<T>, parentSignal: AbortSignal | undefined, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort(parentSignal?.reason);
  parentSignal?.addEventListener('abort', onAbort, { once: true });
  const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    return await operation(controller.signal);
  } catch (error) {
    if (timedOut && !parentSignal?.aborted) throw new ModelTransportError('Model request timed out', { code: 'model_timeout', retryable: true });
    throw error;
  } finally {
    clearTimeout(timeout);
    parentSignal?.removeEventListener('abort', onAbort);
  }
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1_000);
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : undefined;
}

function sleep(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (delayMs <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const done = () => { signal?.removeEventListener('abort', onAbort); resolve(); };
    const onAbort = () => { clearTimeout(timeout); signal?.removeEventListener('abort', onAbort); reject(abortError(signal)); };
    const timeout = setTimeout(done, delayMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

function abortError(signal?: AbortSignal): Error {
  const reason = signal?.reason;
  if (reason instanceof Error && reason.name !== 'AbortError') return reason;
  return new Error('Model request cancelled');
}

function isAbortError(error: unknown): boolean { return error instanceof Error && (error.name === 'AbortError' || error.message === 'This operation was aborted'); }
function clampInteger(value: number, min: number, max: number): number { return Math.min(max, Math.max(min, Math.floor(value))); }
