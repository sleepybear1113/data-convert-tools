import { describe, expect, it } from 'vitest'

import { chunkIterable } from '../../../src/core/utils/chunks'

async function* numbers(): AsyncGenerator<number> {
  yield 1
  yield 2
  yield 3
}

describe('chunkIterable', () => {
  it('keeps the final partial chunk', async () => {
    const chunks: number[][] = []
    for await (const chunk of chunkIterable(numbers(), 2)) {
      chunks.push([...chunk])
    }
    expect(chunks).toEqual([[1, 2], [3]])
  })
})
