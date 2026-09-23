import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { OpenAPIV3 } from 'openapi-types'
import type { HttpClient } from '../client/http-client'

type Operation = OpenAPIV3.OperationObject & { method: string; path: string }
type AttachmentKind = 'file' | 'image' | 'html'

type AttachmentArguments = {
  parentId: string
  filePath?: string
  htmlContent?: string
  kind?: AttachmentKind
  after?: string
}

const SINGLE_PART_LIMIT = 20 * 1024 * 1024
const PART_SIZE = 10 * 1024 * 1024
const MAX_PARTS = 1000

const mimeTypes: Record<string, string> = {
  '.bmp': 'image/bmp',
  '.gif': 'image/gif',
  '.heic': 'image/heic',
  '.htm': 'text/html',
  '.html': 'text/html',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.webp': 'image/webp',
}

export const internalFileUploadOperations = new Set([
  'create-file-upload',
  'send-file-upload',
  'complete-file-upload',
])

export function parseAttachmentArguments(raw: unknown): AttachmentArguments {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Arguments must be an object.')
  }
  const args = raw as Record<string, unknown>
  const parentId = nonEmptyString(args.parent_id, 'parent_id')
  const filePath = args.file_path === undefined ? undefined : nonEmptyString(args.file_path, 'file_path')
  const htmlContent = args.html_content === undefined ? undefined : nonEmptyString(args.html_content, 'html_content', false)
  if (Boolean(filePath) === Boolean(htmlContent)) {
    throw new Error('Provide exactly one of file_path or html_content.')
  }
  if (filePath && !path.isAbsolute(filePath)) {
    throw new Error('file_path must be an absolute path on the MCP server host.')
  }
  const kind = args.kind === undefined ? undefined : args.kind
  if (kind !== undefined && kind !== 'file' && kind !== 'image' && kind !== 'html') {
    throw new Error('kind must be file, image, or html.')
  }
  if (htmlContent && kind && kind !== 'html') {
    throw new Error('html_content requires kind html.')
  }
  const after = args.after === undefined ? undefined : nonEmptyString(args.after, 'after')
  return { parentId, filePath, htmlContent, kind, after }
}

function nonEmptyString(value: unknown, name: string, trim = true): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${name} must be a non-empty string.`)
  }
  return trim ? value.trim() : value
}

function requiredOperation(lookup: Record<string, Operation>, name: string): Operation {
  const operation = lookup[`API-${name}`]
  if (!operation) throw new Error(`Required Notion operation ${name} is unavailable.`)
  return operation
}

function uploadedId(data: unknown, expectedStatus: 'pending' | 'uploaded'): string {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Notion returned an invalid File Upload object.')
  }
  const upload = data as Record<string, unknown>
  if (typeof upload.id !== 'string' || !upload.id || upload.status !== expectedStatus) {
    throw new Error(`Notion File Upload is not ${expectedStatus}: ${JSON.stringify({ id: upload.id, status: upload.status })}`)
  }
  return upload.id
}

function attachmentKind(filename: string, requested?: AttachmentKind): AttachmentKind {
  const extension = path.extname(filename).toLowerCase()
  const inferred: AttachmentKind = extension === '.html' || extension === '.htm'
    ? 'html'
    : mimeTypes[extension]?.startsWith('image/') ? 'image' : 'file'
  const kind = requested ?? inferred
  if (kind === 'html' && extension !== '.html' && extension !== '.htm') {
    throw new Error('An HTML block requires a .html or .htm file.')
  }
  if (kind === 'image' && !mimeTypes[extension]?.startsWith('image/')) {
    throw new Error('An image block requires a supported image filename extension.')
  }
  return kind
}

function appendWithCurrentVersion(operation: Operation): Operation {
  return {
    ...operation,
    parameters: [
      ...(operation.parameters ?? []).filter(parameter =>
        !('$ref' in parameter && parameter.$ref === '#/components/parameters/notionVersion')),
      {
        name: 'Notion-Version',
        in: 'header',
        schema: { type: 'string', default: '2026-03-11' },
      },
    ],
  }
}

/** Upload a local file, then attach it as one Notion file, image, or HTML block. */
export async function uploadNotionAttachment(
  httpClient: HttpClient,
  lookup: Record<string, Operation>,
  rawArguments: unknown,
): Promise<Record<string, unknown>> {
  const args = parseAttachmentArguments(rawArguments)
  let temporaryDirectory: string | undefined
  try {
    let filePath = args.filePath
    if (args.htmlContent !== undefined) {
      temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'notion-html-'))
      filePath = path.join(temporaryDirectory, 'index.html')
      await fs.writeFile(filePath, args.htmlContent, 'utf8')
    }
    if (!filePath) throw new Error('Missing upload file.')

    const filename = path.basename(filePath)
    if (Buffer.byteLength(filename, 'utf8') > 900) {
      throw new Error('The filename exceeds Notion\'s 900-byte limit.')
    }
    const kind = attachmentKind(filename, args.kind ?? (args.htmlContent ? 'html' : undefined))
    const stat = await fs.stat(filePath)
    if (!stat.isFile() || stat.size === 0) {
      throw new Error('file_path must point to a non-empty regular file.')
    }
    const multiPart = stat.size > SINGLE_PART_LIMIT
    const numberOfParts = multiPart ? Math.ceil(stat.size / PART_SIZE) : 1
    if (numberOfParts > MAX_PARTS) {
      throw new Error(`File requires ${numberOfParts} parts; the supported maximum is ${MAX_PARTS}.`)
    }

    const create = requiredOperation(lookup, 'create-file-upload')
    const send = requiredOperation(lookup, 'send-file-upload')
    const complete = multiPart ? requiredOperation(lookup, 'complete-file-upload') : undefined
    const append = appendWithCurrentVersion(requiredOperation(lookup, 'patch-block-children'))
    const extension = path.extname(filename).toLowerCase()
    const created = await httpClient.executeOperation<unknown>(create, {
      mode: multiPart ? 'multi_part' : 'single_part',
      filename,
      ...(mimeTypes[extension] ? { content_type: mimeTypes[extension] } : {}),
      ...(multiPart ? { number_of_parts: numberOfParts } : {}),
    })
    const fileUploadId = uploadedId(created.data, 'pending')

    for (let index = 0; index < numberOfParts; index++) {
      const start = index * PART_SIZE
      const end = Math.min(stat.size, start + PART_SIZE) - 1
      const file = multiPart ? { path: filePath, filename, start, end } : filePath
      const sent = await httpClient.executeOperation<unknown>(send, {
        file_upload_id: fileUploadId,
        file,
        ...(multiPart ? { part_number: String(index + 1) } : {}),
      })
      uploadedId(sent.data, multiPart ? 'pending' : 'uploaded')
    }

    if (complete) {
      const completed = await httpClient.executeOperation<unknown>(complete, { file_upload_id: fileUploadId })
      uploadedId(completed.data, 'uploaded')
    }

    const blockType = kind === 'html' ? 'embed' : kind
    let appended
    try {
      appended = await httpClient.executeOperation<unknown>(append, {
        block_id: args.parentId,
        children: [{
          type: blockType,
          [blockType]: { type: 'file_upload', file_upload: { id: fileUploadId } },
        }],
        ...(args.after ? { after: args.after } : {}),
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`File uploaded as ${fileUploadId}, but attaching the block failed: ${message}`)
    }
    const result = appended.data as { results?: Array<{ id?: string }> } | undefined
    const blockId = result?.results?.[0]?.id
    if (!blockId) {
      throw new Error(`Notion did not return the attached block ID. File Upload ID: ${fileUploadId}`)
    }
    return {
      parent_id: args.parentId,
      block_id: blockId,
      block_type: blockType,
      file_upload_id: fileUploadId,
      filename,
      size_bytes: stat.size,
    }
  } finally {
    if (temporaryDirectory) await fs.rm(temporaryDirectory, { recursive: true, force: true })
  }
}
