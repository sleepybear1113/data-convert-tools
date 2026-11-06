import type {
  WorkerPayload,
  WorkerRequest,
  WorkerRequestType,
  WorkerResponse,
  WorkerResultMap,
} from './protocol'

export interface WorkerHandlerContext {
  reportProgress(current: number, total?: number, message?: string): void
}

export type WorkerHandlers = {
  [TType in WorkerRequestType]: (
    payload: WorkerPayload<TType>,
    context: WorkerHandlerContext,
  ) => Promise<WorkerResultMap[TType]>
}

export interface WorkerScope {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null
  postMessage(response: WorkerResponse): void
}

interface ErrorWithDetails extends Error {
  code?: string
  details?: Readonly<Record<string, unknown>>
  result?: {
    diagnostics?: readonly { code: string }[]
  }
}

export function attachWorkerHandlers(scope: WorkerScope, handlers: WorkerHandlers): void {
  let queue = Promise.resolve()

  scope.onmessage = (event) => {
    const request = event.data
    queue = queue.catch(() => undefined).then(async () => {
      try {
        const context: WorkerHandlerContext = {
          reportProgress(current, total, message) {
            scope.postMessage({
              id: request.id,
              type: 'progress',
              progress: { current, total, message },
            })
          },
        }
        const handler = handlers[request.type] as (
          payload: WorkerPayload<WorkerRequestType>,
          context: WorkerHandlerContext,
        ) => Promise<WorkerResultMap[WorkerRequestType]>
        const data = await handler(request.payload, context)
        scope.postMessage({ id: request.id, type: 'result', data })
      } catch (error) {
        const cause = error instanceof Error ? error as ErrorWithDetails : undefined
        scope.postMessage({
          id: request.id,
          type: 'error',
          error: {
            code: cause?.code
              ?? cause?.result?.diagnostics?.[0]?.code
              ?? 'WORKER_OPERATION_FAILED',
            message: cause?.message ?? String(error),
            details: {
              ...cause?.details,
              ...(cause?.result ? { result: cause.result } : {}),
            },
          },
        })
      }
    })
  }
}
