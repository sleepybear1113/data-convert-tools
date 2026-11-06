import type { TableSchema } from './table'

export const METADATA_TABLE_NAME = '__dct_metadata'
export const METADATA_SCHEMA_VERSION = 1

interface MetadataEnvelope {
  version: number
  table: TableSchema
}

interface TaggedValue {
  $dctType: 'bigint' | 'bytes'
  value: string | number[]
}

function isTaggedValue(value: unknown): value is TaggedValue {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<TaggedValue>
  return candidate.$dctType === 'bigint' || candidate.$dctType === 'bytes'
}

export function serializeTableMetadata(table: TableSchema): string {
  const envelope: MetadataEnvelope = {
    version: METADATA_SCHEMA_VERSION,
    table,
  }

  return JSON.stringify(envelope, (_key, value: unknown) => {
    if (typeof value === 'bigint') {
      return { $dctType: 'bigint', value: value.toString() }
    }
    if (value instanceof Uint8Array) {
      return { $dctType: 'bytes', value: Array.from(value) }
    }
    return value
  })
}

export function parseTableMetadata(serialized: string): TableSchema {
  const envelope = JSON.parse(serialized, (_key, value: unknown) => {
    if (isTaggedValue(value)) {
      if (value.$dctType === 'bigint') return BigInt(value.value as string)
      return new Uint8Array(value.value as number[])
    }
    return value
  }) as MetadataEnvelope

  if (envelope.version !== METADATA_SCHEMA_VERSION || !envelope.table?.columns) {
    throw new Error('Unsupported or invalid workspace metadata')
  }

  return envelope.table
}
