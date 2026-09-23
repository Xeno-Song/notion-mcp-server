import { promises as fs, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OpenAPIV3 } from 'openapi-types'
import type { HttpClient } from '../../client/http-client'
import { OpenAPIToMCPConverter } from '../../openapi/parser'
import { parseAttachmentArguments, uploadNotionAttachment } from '../notion-attachment'
const notionSpec = JSON.parse(readFileSync(path.resolve(process.cwd(), 'scripts/notion-openapi.json'), 'utf8')) as OpenAPIV3.Document
const { openApiLookup } = new OpenAPIToMCPConverter(notionSpec).convertToMCPTools()

describe('upload-notion-attachment', () => {
  let directory: string
  let executeOperation: ReturnType<typeof vi.fn>
  let client: HttpClient

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'notion-upload-test-'))
    executeOperation = vi.fn(async (operation: { operationId: string }) => {
      if (operation.operationId === 'create-file-upload') return { data: { id: 'upload-1', status: 'pending' } }
      if (operation.operationId === 'send-file-upload') return { data: { id: 'upload-1', status: 'uploaded' } }
      if (operation.operationId === 'complete-file-upload') return { data: { id: 'upload-1', status: 'uploaded' } }
      if (operation.operationId === 'patch-block-children') return { data: { results: [{ id: 'block-1' }] } }
      throw new Error(`Unexpected operation ${operation.operationId}`)
    })
    client = { executeOperation } as unknown as HttpClient
  })

  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true })
  })

  it('uploads and attaches an image block', async () => {
    const filePath = path.join(directory, 'photo.png')
    await fs.writeFile(filePath, Buffer.from('image'))

    const result = await uploadNotionAttachment(client, openApiLookup, {
      parent_id: 'page-1', file_path: filePath, after: 'previous-block',
    })

    expect(result).toEqual({
      parent_id: 'page-1', block_id: 'block-1', block_type: 'image',
      file_upload_id: 'upload-1', filename: 'photo.png', size_bytes: 5,
    })
    expect(executeOperation.mock.calls.map(call => call[0].operationId)).toEqual([
      'create-file-upload', 'send-file-upload', 'patch-block-children',
    ])
    expect(executeOperation.mock.calls[0][1]).toEqual({
      mode: 'single_part', filename: 'photo.png', content_type: 'image/png',
    })
    expect(executeOperation.mock.calls[1][1]).toEqual({ file_upload_id: 'upload-1', file: filePath })
    expect(executeOperation.mock.calls[2][1]).toEqual({
      block_id: 'page-1', after: 'previous-block',
      children: [{ type: 'image', image: { type: 'file_upload', file_upload: { id: 'upload-1' } } }],
    })
    expect(executeOperation.mock.calls[2][0].parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Notion-Version', schema: expect.objectContaining({ default: '2026-03-11' }) }),
    ]))
  })

  it('attaches a regular file block', async () => {
    const filePath = path.join(directory, 'report.pdf')
    await fs.writeFile(filePath, Buffer.from('pdf'))

    const result = await uploadNotionAttachment(client, openApiLookup, { parent_id: 'page-1', file_path: filePath })

    expect(result.block_type).toBe('file')
    expect(executeOperation.mock.calls[2][1].children).toEqual([
      { type: 'file', file: { type: 'file_upload', file_upload: { id: 'upload-1' } } },
    ])
  })

  it('writes inline HTML to a temporary file and attaches an embed', async () => {
    const result = await uploadNotionAttachment(client, openApiLookup, {
      parent_id: 'page-1', html_content: '<h1>Hello</h1>',
    })

    expect(result.block_type).toBe('embed')
    expect(result.filename).toBe('index.html')
    expect(executeOperation.mock.calls[2][1].children).toEqual([
      { type: 'embed', embed: { type: 'file_upload', file_upload: { id: 'upload-1' } } },
    ])
    const temporaryFile = executeOperation.mock.calls[1][1].file as string
    await expect(fs.stat(temporaryFile)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('splits a large file into ranged parts and completes before attaching', async () => {
    const filePath = path.join(directory, 'large.pdf')
    const file = await fs.open(filePath, 'w')
    await file.truncate(21 * 1024 * 1024)
    await file.close()
    executeOperation.mockImplementation(async (operation: { operationId: string }) => {
      if (operation.operationId === 'create-file-upload') return { data: { id: 'upload-1', status: 'pending' } }
      if (operation.operationId === 'send-file-upload') return { data: { id: 'upload-1', status: 'pending' } }
      if (operation.operationId === 'complete-file-upload') return { data: { id: 'upload-1', status: 'uploaded' } }
      return { data: { results: [{ id: 'block-1' }] } }
    })

    await uploadNotionAttachment(client, openApiLookup, { parent_id: 'page-1', file_path: filePath })

    expect(executeOperation.mock.calls.map(call => call[0].operationId)).toEqual([
      'create-file-upload', 'send-file-upload', 'send-file-upload', 'send-file-upload',
      'complete-file-upload', 'patch-block-children',
    ])
    expect(executeOperation.mock.calls[0][1].number_of_parts).toBe(3)
    expect(executeOperation.mock.calls.slice(1, 4).map(call => call[1])).toEqual([
      { file_upload_id: 'upload-1', part_number: '1', file: { path: filePath, filename: 'large.pdf', start: 0, end: 10485759 } },
      { file_upload_id: 'upload-1', part_number: '2', file: { path: filePath, filename: 'large.pdf', start: 10485760, end: 20971519 } },
      { file_upload_id: 'upload-1', part_number: '3', file: { path: filePath, filename: 'large.pdf', start: 20971520, end: 22020095 } },
    ])
  })

  it('rejects ambiguous input before any request', async () => {
    expect(() => parseAttachmentArguments({ parent_id: 'page-1', file_path: 'relative.png' })).toThrow('absolute path')
    expect(() => parseAttachmentArguments({ parent_id: 'page-1', html_content: '<p>x</p>', file_path: 'C:\\x.html' })).toThrow('exactly one')
    expect(executeOperation).not.toHaveBeenCalled()
  })

  it('reports the uploaded ID if attaching fails', async () => {
    const filePath = path.join(directory, 'report.pdf')
    await fs.writeFile(filePath, Buffer.from('pdf'))
    executeOperation.mockImplementation(async (operation: { operationId: string }) => {
      if (operation.operationId === 'create-file-upload') return { data: { id: 'upload-1', status: 'pending' } }
      if (operation.operationId === 'send-file-upload') return { data: { id: 'upload-1', status: 'uploaded' } }
      throw new Error('Access denied')
    })

    await expect(uploadNotionAttachment(client, openApiLookup, { parent_id: 'page-1', file_path: filePath }))
      .rejects.toThrow('File uploaded as upload-1, but attaching the block failed: Access denied')
  })
})
