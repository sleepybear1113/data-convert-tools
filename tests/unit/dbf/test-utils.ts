import type {
  DbfFieldDescriptor,
  DbfFieldType,
  DbfRecord,
  DbfRecordSource,
} from '../../../src/core/dbf/types'

export function dbfField(
  name: string,
  type: DbfFieldType,
  length: number,
  decimalPlaces = 0,
  overrides: Partial<DbfFieldDescriptor> = {},
): DbfFieldDescriptor {
  return {
    name,
    type,
    length,
    decimalPlaces,
    flags: 0,
    nullable: false,
    system: false,
    ...overrides,
  }
}

export function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(buffer).set(bytes)
  return buffer
}

export async function collectRecords(source: AsyncIterable<DbfRecord>): Promise<DbfRecord[]> {
  const records: DbfRecord[] = []
  for await (const record of source) records.push(record)
  return records
}

export function recordSource(records: readonly DbfRecord[]): DbfRecordSource {
  return {
    recordCount: records.length,
    records: (async function* () {
      yield* records
    })(),
  }
}

export function dbfRecord(values: DbfRecord['values'], deleted = false): DbfRecord {
  return { values, deleted }
}
