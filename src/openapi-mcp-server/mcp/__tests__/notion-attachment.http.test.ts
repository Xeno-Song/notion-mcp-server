import { promises as fs, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Server } from 'node:http'
import express from 'express'
import type { OpenAPIV3 } from 'openapi-types'
import { afterEach, describe, expect, it } from 'vitest'
import { HttpClient } from '../../client/http-client'
import { startTestServer, stopTestServer } from '../../client/__tests__/test-server'
import { OpenAPIToMCPConverter } from '../../openapi/parser'
import { uploadNotionAttachment } from '../notion-attachment'

describe('Notion attachment HTTP request', () => {
  let server: Server | undefined
  let directory: string | undefined

  afterEach(async () => {
    await stopTestServer(server)
    if (directory) await fs.rm(directory, { recursive: true, force: true })
  })

  it('sends JSON, multipart file bytes, then a file-upload-backed HTML block', async () => {
    const observed: Array<{ path: string; body: unknown; version: string | undefined }> = []
    const app = express()
    app.post('/v1/file_uploads', express.json(), (request, response) => {
      observed.push({ path: request.path, body: request.body, version: request.header('Notion-Version') })
      response.json({ id: 'upload-1', status: 'pending' })
    })
    app.post('/v1/file_uploads/:file_upload_id/send', express.raw({ type: 'multipart/form-data' }), (request, response) => {
      const multipart = (request.body as Buffer).toString('utf8')
      observed.push({
        path: request.path,
        body: {
          hasFileField: multipart.includes('name="file"'),
          hasHtml: multipart.includes('<h1>Widget</h1>'),
          hasFilename: multipart.includes('filename="widget.html"'),
          hasPathIdField: multipart.includes('name="file_upload_id"'),
        },
        version: request.header('Notion-Version'),
      })
      response.json({ id: 'upload-1', status: 'uploaded' })
    })
    app.patch('/v1/blocks/:block_id/children', express.json(), (request, response) => {
      observed.push({ path: request.path, body: request.body, version: request.header('Notion-Version') })
      response.json({ results: [{ id: 'block-1' }] })
    })
    const { server: started, baseUrl } = await startTestServer(app)
    server = started
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'notion-upload-http-'))
    const filePath = path.join(directory, 'widget.html')
    await fs.writeFile(filePath, '<h1>Widget</h1>', 'utf8')

    const spec = JSON.parse(readFileSync(path.resolve(process.cwd(), 'scripts/notion-openapi.json'), 'utf8')) as OpenAPIV3.Document
    spec.servers = [{ url: baseUrl }]
    const { openApiLookup } = new OpenAPIToMCPConverter(spec).convertToMCPTools()
    const client = new HttpClient({ baseUrl }, spec)

    const result = await uploadNotionAttachment(client, openApiLookup, { parent_id: 'page-1', file_path: filePath })

    expect(result.block_id).toBe('block-1')
    expect(observed).toEqual([
      {
        path: '/v1/file_uploads',
        body: { mode: 'single_part', filename: 'widget.html', content_type: 'text/html' },
        version: '2026-03-11',
      },
      {
        path: '/v1/file_uploads/upload-1/send',
        body: { hasFileField: true, hasHtml: true, hasFilename: true, hasPathIdField: false },
        version: '2026-03-11',
      },
      {
        path: '/v1/blocks/page-1/children',
        body: { children: [{ type: 'embed', embed: { type: 'file_upload', file_upload: { id: 'upload-1' } } }] },
        version: '2026-03-11',
      },
    ])
  })
})
