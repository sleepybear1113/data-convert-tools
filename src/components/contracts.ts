import type { CsvReadOptions, CsvWriteOptions } from '../core/formats/csv'
import type { XlsxReadOptions, XlsxWriteOptions } from '../core/formats/xlsx'
import type { ExportOptions } from '../core/model/conversion'

export type ImportFormat = 'dbf' | 'sqlite' | 'xlsx' | 'csv'
export type ImportFormatOption = ImportFormat | 'auto'

interface FileImportBase {
  /** 原始文件只传给父层适配器，组件不会读取、解析或上传它。 */
  file: File
}

export type FileImportRequest =
  | (FileImportBase & {
      format: 'dbf'
      options: {
        encoding: string
        includeDeleted: boolean
        strict: boolean
      }
    })
  | (FileImportBase & { format: 'csv'; options: CsvReadOptions })
  | (FileImportBase & { format: 'xlsx'; options: XlsxReadOptions })
  | (FileImportBase & { format: 'sqlite'; options: Record<string, never> })

export interface WorkspaceExportOptions extends ExportOptions {
  /** DBF/CSV 编码；XLSX 与 SQLite 导出时保留默认值即可。 */
  encoding: 'utf-8' | 'gbk' | 'gb18030'
  csv: CsvWriteOptions
  xlsx: XlsxWriteOptions
}

export interface ResultPageChange {
  offset: number
  limit: number
}
