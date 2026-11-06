import { describe, expect, it, vi } from 'vitest'

import { attachWorkerHandlers } from '../../../src/workers/dispatch'
import type { WorkerHandlers, WorkerScope } from '../../../src/workers/dispatch'
import type { WorkerResponse } from '../../../src/workers/protocol'

function createScope() {
  const responses: WorkerResponse[] = []
  const scope: WorkerScope = {
    onmessage: null,
    postMessage(response) {
      responses.push(response)
    },
  }
  return { scope, responses }
}

describe('attachWorkerHandlers', () => {
  it('returns results and progress', async () => {
    const { scope, responses } = createScope()
    const handlers: Pick<WorkerHandlers, 'workspace:reset'> = {
      'workspace:reset': async (_payload, context) => {
        context.reportProgress(1, 2)
        return { reset: true as const }
      },
    }
    attachWorkerHandlers(scope, handlers as unknown as WorkerHandlers)

    scope.onmessage?.({
      data: { id: 'request-1', type: 'workspace:reset', payload: {} },
    } as MessageEvent)

    await vi.waitFor(() => expect(responses).toHaveLength(2))
    expect(responses[0]).toMatchObject({ type: 'progress', progress: { current: 1, total: 2 } })
    expect(responses[1]).toEqual({ id: 'request-1', type: 'result', data: { reset: true } })
  })

  it('normalizes operation errors', async () => {
    const { scope, responses } = createScope()
    const handlers = {
      'sqlite:execute': async () => {
        throw Object.assign(new Error('invalid SQL'), { code: 'SQL_ERROR' })
      },
    } as unknown as WorkerHandlers
    attachWorkerHandlers(scope, handlers)

    scope.onmessage?.({
      data: { id: 'request-2', type: 'sqlite:execute', payload: { sql: 'bad' } },
    } as MessageEvent)

    await vi.waitFor(() => expect(responses).toHaveLength(1))
    expect(responses[0]).toMatchObject({
      id: 'request-2',
      type: 'error',
      error: { code: 'SQL_ERROR', message: 'invalid SQL' },
    })
  })
})
