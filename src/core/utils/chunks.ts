export async function* chunkIterable<T>(
  source: AsyncIterable<T>,
  size: number,
): AsyncGenerator<readonly T[]> {
  if (!Number.isInteger(size) || size <= 0) {
    throw new RangeError('Chunk size must be a positive integer')
  }

  let chunk: T[] = []

  for await (const item of source) {
    chunk.push(item)
    if (chunk.length === size) {
      yield chunk
      chunk = []
    }
  }

  if (chunk.length > 0) {
    yield chunk
  }
}
