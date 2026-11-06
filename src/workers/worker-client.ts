import type {
  WorkerPayload,
  WorkerRequest,
  WorkerRequestType,
  WorkerResponse,
  WorkerResultMap,
} from './protocol'

export function createDataWorker(): Worker {
  return new Worker(new URL('./data.worker.ts', import.meta.url), {
    type: 'module',
    name: 'data-convert-tools',
  })
}

export class WorkerRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message)
    this.name = 'WorkerRequestError'
  }
}

type ProgressListener = (progress: Extract<WorkerResponse, { type: 'progress' }>['progress']) => void

interface PendingRequest {
  resolve(data: unknown): void
  reject(error: Error): void
}

export class DataWorkerClient {
  private readonly pending = new Map<string, PendingRequest>()
  private readonly progressListeners = new Set<ProgressListener>()

  constructor(private readonly worker: Worker = createDataWorker()) {
    this.worker.addEventListener('message', this.handleMessage)
    this.worker.addEventListener('error', this.handleError)
  }

  request<TType extends WorkerRequestType>(
    type: TType,
    payload: WorkerPayload<TType>,
    transfer: Transferable[] = [],
  ): Promise<WorkerResultMap[TType]> {
    const id = crypto.randomUUID()

    return new Promise<WorkerResultMap[TType]>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (data: unknown) => void,
        reject,
      })

      const request = { id, type, payload } as WorkerRequest
      this.worker.postMessage(request, transfer)
    })
  }

  onProgress(listener: ProgressListener): () => void {
    this.progressListeners.add(listener)
    return () => this.progressListeners.delete(listener)
  }

  terminate(): void {
    this.rejectPending(new Error('Data worker was terminated'))
    this.worker.removeEventListener('message', this.handleMessage)
    this.worker.removeEventListener('error', this.handleError)
    this.worker.terminate()
    this.progressListeners.clear()
  }

  private readonly handleMessage = (event: MessageEvent<WorkerResponse>): void => {
    const response = event.data

    if (response.type === 'progress') {
      for (const listener of this.progressListeners) {
        listener(response.progress)
      }
      return
    }

    const pending = this.pending.get(response.id)
    if (!pending) return

    this.pending.delete(response.id)

    if (response.type === 'error') {
      pending.reject(new WorkerRequestError(
        response.error.code,
        response.error.message,
        response.error.details,
      ))
      return
    }

    pending.resolve(response.data)
  }

  private readonly handleError = (event: ErrorEvent): void => {
    this.rejectPending(new Error(event.message || 'Data worker failed'))
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error)
    }
    this.pending.clear()
  }
}
