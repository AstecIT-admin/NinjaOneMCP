import { AsyncLocalStorage } from 'node:async_hooks';

interface RequestContext {
  token: string | undefined;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

export function getIncomingToken(): string | undefined {
  return requestContext.getStore()?.token;
}
