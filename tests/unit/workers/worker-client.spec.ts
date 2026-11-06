import { describe, expect, it } from 'vitest'

import { DataWorkerClient, WorkerRequestError } from '../../../src/workers/worker-client'
import type { WorkerRequest, WorkerResponse } from '../../../src/workers/protocol'

class MockWorker {
  onPost: ((request: WorkerRequest) => void) | undefined
  private readonly listeners = new Map<string, (event: MessageEvent) => void>()

  addEventListener(type: string, listener: (event: MessageEvent) => void): void {
    this.listeners.set(type, listener)
  }

  removeEventListener(type: string): void {
    this.listeners.delete(type)
  }

  postMessage(request: WorkerRequest): void {
    this.onPost?.(request)
  }

  emit(response: WorkerResponse): void {
    this.listeners.get('message')?.({ data: response } as MessageEvent)
  }

  terminate(): void {}
}

function setup() {
  const worker = new MockWorker()
  const client = new DataWorkerClient(worker as unknown as Worker)
  return { worker, client }
}

describe('DataWorkerClient', () => {
  it('correlates a result with its request', async () => {
    const { worker, client } = setup()
    worker.onPost = (request) => worker.emit({ id: request.id, type: 'result', data: { reset: true } })

    await expect(client.request('workspace:reset', {})).resolves.toEqual({ reset: true })
  })

  it('propagates structured worker errors', async () => {
    const { worker, client } = setup()
    worker.onPost = (request) => worker.emit({
      id: request.id,
      type: 'error',
      error: { code: 'SQL_ERROR', message: 'invalid SQL' },
    })

    const promise = client.request('sqlite:execute', { sql: 'bad' })
    await expect(promise).rejects.toBeInstanceOf(WorkerRequestError)
    await expect(promise).rejects.toMatchObject({ code: 'SQL_ERROR' })
  })

  it('forwards progress events', async () => {
    const { worker, client } = setup()
    const progress: number[] = []
    client.onProgress((event) => progress.push(event.current))
    worker.onPost = (request) => {
      worker.emit({ id: request.id, type: 'progress', progress: { current: 5 } })
      worker.emit({ id: request.id, type: 'result', data: { reset: true } })
    }

    await client.request('workspace:reset', {})
    expect(progress).toEqual([5])
  })
})
