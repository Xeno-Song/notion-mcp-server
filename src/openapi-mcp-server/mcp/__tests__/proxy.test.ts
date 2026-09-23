import { MCPProxy } from '../proxy'
import { OpenAPIV3 } from 'openapi-types'
import { HttpClient } from '../../client/http-client'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'

// Mock the dependencies
vi.mock('../../client/http-client')
vi.mock('@modelcontextprotocol/sdk/server/index.js')

describe('MCPProxy', () => {
  let proxy: MCPProxy
  let mockOpenApiSpec: OpenAPIV3.Document

  beforeEach(() => {
    // Reset all mocks
    vi.clearAllMocks()

    // Setup minimal OpenAPI spec for testing
    mockOpenApiSpec = {
      openapi: '3.0.0',
      servers: [{ url: 'http://localhost:3000' }],
      info: {
        title: 'Test API',
        version: '1.0.0',
      },
      paths: {
        '/test': {
          get: {
            operationId: 'getTest',
            responses: {
              '200': {
                description: 'Success',
              },
            },
          },
        },
      },
    }

    proxy = new MCPProxy('test-proxy', mockOpenApiSpec)
  })

  describe('listTools handler', () => {
    it('should return converted tools from OpenAPI spec', async () => {
      const server = (proxy as any).server
      const listToolsHandler = server.setRequestHandler.mock.calls[0].filter((x: unknown) => typeof x === 'function')[0]
      const result = await listToolsHandler()

      expect(result).toHaveProperty('tools')
      expect(Array.isArray(result.tools)).toBe(true)
    })

    it('should expose the Jev-backed Notion document ranking tool', async () => {
      const server = (proxy as any).server
      const listToolsHandler = server.setRequestHandler.mock.calls[0].filter((x: unknown) => typeof x === 'function')[0]
      const result = await listToolsHandler()

      expect(result.tools).toEqual(expect.arrayContaining([
        expect.objectContaining({
          name: 'rank-notion-documents',
          annotations: expect.objectContaining({ readOnlyHint: true }),
        }),
        expect.objectContaining({ name: 'find-notion-sections' }),
        expect.objectContaining({ name: 'get-notion-heading-tree' }),
        expect.objectContaining({ name: 'get-notion-section-content' }),
      ]))
    })

    it('should truncate tool names exceeding 64 characters', async () => {
      // Setup OpenAPI spec with long tool names
      mockOpenApiSpec.paths = {
        '/test': {
          get: {
            operationId: 'a'.repeat(65),
            responses: {
              '200': {
                description: 'Success'
              }
            }
          }
        }
      }
      proxy = new MCPProxy('test-proxy', mockOpenApiSpec)
      const server = (proxy as any).server
      const listToolsHandler = server.setRequestHandler.mock.calls[0].filter((x: unknown) => typeof x === 'function')[0];
      const result = await listToolsHandler()

      expect(result.tools[0].name.length).toBeLessThanOrEqual(64)
    })
  })

  describe('callTool handler', () => {
    it('returns a Heading tree and only the selected logical Heading section as Markdown', async () => {
      const mockResponse = (data: unknown) => ({
        data,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
      })
      ;(HttpClient.prototype.executeOperation as ReturnType<typeof vi.fn>).mockImplementation(
        async (operation: { operationId: string }, params: Record<string, unknown>) => {
          expect(operation.operationId).toBe('get-block-children')
          if (params.block_id === 'list-1') {
            return mockResponse({
              results: [
                { id: 'nested-detail', type: 'paragraph', paragraph: { rich_text: [{ plain_text: 'Nested approval detail.' }] } },
              ],
              has_more: false,
            })
          }
          if (params.block_id === 'child-page-1') {
            throw new Error('Child pages must not be traversed.')
          }
          if (params.block_id === 'child-database-1') {
            throw new Error('Child databases must not be traversed.')
          }
          return mockResponse({
            results: [
              { id: 'page-preface', type: 'paragraph', paragraph: { rich_text: [{ plain_text: 'Page preface.' }] } },
              { id: 'heading-release', type: 'heading_1', heading_1: { rich_text: [{ plain_text: 'Release' }] } },
              { id: 'release-intro', type: 'paragraph', paragraph: { rich_text: [{ plain_text: 'Release overview.' }] } },
              { id: 'heading-approval', type: 'heading_2', heading_2: { rich_text: [{ plain_text: 'Approval' }] } },
              { id: 'approval-detail', type: 'paragraph', paragraph: { rich_text: [{ plain_text: 'Approval is required.' }] } },
              { id: 'list-1', type: 'bulleted_list_item', has_children: true, bulleted_list_item: { rich_text: [{ plain_text: 'Conditions' }] } },
              { id: 'child-page-1', type: 'child_page', has_children: true, child_page: { title: 'Nested document' } },
              { id: 'child-database-1', type: 'child_database', has_children: true, child_database: { title: 'Nested database' } },
              { id: 'heading-operations', type: 'heading_1', heading_1: { rich_text: [{ plain_text: 'Operations' }] } },
              { id: 'operations-detail', type: 'paragraph', paragraph: { rich_text: [{ plain_text: 'Operational content.' }] } },
            ],
            has_more: false,
          })
        },
      )
      ;(proxy as any).openApiLookup = {
        'API-get-block-children': {
          operationId: 'get-block-children', responses: {}, method: 'get', path: '/blocks/{block_id}/children',
        },
      }
      const server = (proxy as any).server
      const handlers = server.setRequestHandler.mock.calls.flatMap((x: unknown[]) => x).filter((x: unknown) => typeof x === 'function')
      const callToolHandler = handlers[1]

      const headingsResult = await callToolHandler({
        params: { name: 'get-notion-heading-tree', arguments: { page_id: 'page-1' } },
      })
      expect(JSON.parse(headingsResult.content[0].text)).toEqual({
        page_id: 'page-1',
        headings: [
          { block_id: 'heading-release', level: 1, text: 'Release', parent_heading_id: null, heading_path: ['Release'] },
          { block_id: 'heading-approval', level: 2, text: 'Approval', parent_heading_id: 'heading-release', heading_path: ['Release', 'Approval'] },
          { block_id: 'heading-operations', level: 1, text: 'Operations', parent_heading_id: null, heading_path: ['Operations'] },
        ],
      })

      const sectionResult = await callToolHandler({
        params: {
          name: 'get-notion-section-content',
          arguments: { page_id: 'page-1', heading_id: 'heading-approval' },
        },
      })
      expect(JSON.parse(sectionResult.content[0].text)).toEqual({
        page_id: 'page-1',
        heading_id: 'heading-approval',
        markdown: '## Approval\n\nApproval is required.\n\n- Conditions\n\n  Nested approval detail.',
      })

      const rootResult = await callToolHandler({
        params: {
          name: 'get-notion-section-content',
          arguments: { page_id: 'page-1', heading_id: null },
        },
      })
      expect(JSON.parse(rootResult.content[0].text)).toEqual({
        page_id: 'page-1',
        heading_id: null,
        markdown: 'Page preface.',
      })
      expect(HttpClient.prototype.executeOperation).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ block_id: 'child-page-1' }),
      )
      expect(HttpClient.prototype.executeOperation).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ block_id: 'child-database-1' }),
      )
    })


    it('locates non-overlapping Heading sections for several known page IDs', async () => {
      const mockResponse = (data: unknown) => ({
        data,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
      })
      ;(HttpClient.prototype.executeOperation as ReturnType<typeof vi.fn>).mockImplementation(
        async (_operation: { operationId: string }, params: Record<string, unknown>) => {
          if (params.block_id === 'page-1') {
            return mockResponse({
              results: [
                { id: 'preface-1', type: 'paragraph', paragraph: { rich_text: [{ plain_text: 'General introduction.' }] } },
                { id: 'release-1', type: 'heading_1', heading_1: { rich_text: [{ plain_text: 'Release' }] } },
                { id: 'release-body-1', type: 'paragraph', paragraph: { rich_text: [{ plain_text: 'Release overview.' }] } },
                { id: 'approval-1', type: 'heading_2', heading_2: { rich_text: [{ plain_text: 'Approval' }] } },
                { id: 'approval-body-1', type: 'paragraph', paragraph: { rich_text: [{ plain_text: 'The operator must approve.' }] } },
              ],
              has_more: false,
            })
          }
          return mockResponse({
            results: [
              { id: 'preface-2', type: 'paragraph', paragraph: { rich_text: [{ plain_text: 'HR owns leave requests.' }] } },
            ],
            has_more: false,
          })
        },
      )
      ;(proxy as any).openApiLookup = {
        'API-get-block-children': {
          operationId: 'get-block-children', responses: {}, method: 'get', path: '/blocks/{block_id}/children',
        },
      }
      const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
        model: 'jev-1.13.0',
        answers: {
          page_0: {
            type: 'choice',
            choice: 'section_2',
            probabilities: { section_0: 0.05, section_1: 0.12, section_2: 0.83 },
            confidence: 0.9,
          },
          page_1: {
            type: 'choice',
            choice: 'section_0',
            probabilities: { section_0: 1 },
            confidence: 0.9,
          },
        },
        usage: { input_tokens: 100, output_tokens: 20 },
      }), { status: 200 }))
      vi.stubGlobal('fetch', fetchMock)
      const previousKey = process.env.TYPESAFE_API_KEY
      process.env.TYPESAFE_API_KEY = 'test-key'

      try {
        const server = (proxy as any).server
        const handlers = server.setRequestHandler.mock.calls.flatMap((x: unknown[]) => x).filter((x: unknown) => typeof x === 'function')
        const result = await handlers[1]({
          params: {
            name: 'find-notion-sections',
            arguments: { page_ids: ['page-1', 'page-2'], question: 'Who approves releases?', top_k: 2 },
          },
        })

        expect(JSON.parse(result.content[0].text)).toEqual({
          'page-1': [
            { heading_id: 'approval-1', heading_path: ['Release', 'Approval'], score: 0.83, confidence: 0.9 },
            { heading_id: 'release-1', heading_path: ['Release'], score: 0.12, confidence: 0.9 },
          ],
          'page-2': [
            { heading_id: null, heading_path: [], score: 1, confidence: 0.9 },
          ],
        })

        const request = JSON.parse(fetchMock.mock.calls[0]![1].body as string)
        expect(request.questions.page_0.criteria).toEqual({
          section_0: { heading_path: [], content: 'General introduction.' },
          section_1: { heading_path: ['Release'], content: 'Release overview.' },
          section_2: { heading_path: ['Release', 'Approval'], content: 'The operator must approve.' },
        })
      } finally {
        if (previousKey === undefined) delete process.env.TYPESAFE_API_KEY
        else process.env.TYPESAFE_API_KEY = previousKey
        vi.unstubAllGlobals()
      }
    })

    it('searches Notion by keyword and returns one compact result list per Jev question', async () => {
      const mockResponse = (data: unknown) => ({
        data,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
      })
      ;(HttpClient.prototype.executeOperation as ReturnType<typeof vi.fn>).mockImplementation(
        async (operation: { operationId: string }, params: Record<string, unknown>) => {
          if (operation.operationId === 'post-search') {
            expect(params).toEqual({
              query: '배포 승인',
              filter: { property: 'object', value: 'page' },
              page_size: 100,
            })
            return mockResponse({
              results: [
                {
                  object: 'page',
                  id: 'page-1',
                  url: 'https://notion.so/page-1',
                  properties: {
                    Name: { type: 'title', title: [{ plain_text: '운영 배포 가이드' }] },
                  },
                },
              ],
            })
          }
          expect(operation.operationId).toBe('retrieve-page-markdown')
          expect(params).toEqual({ page_id: 'page-1', include_transcript: false })
          return mockResponse({ markdown: '# 승인 절차', truncated: false })
        },
      )
      ;(proxy as any).openApiLookup = {
        'API-post-search': { operationId: 'post-search', responses: {}, method: 'post', path: '/search' },
        'API-retrieve-page-markdown': {
          operationId: 'retrieve-page-markdown', responses: {}, method: 'get', path: '/pages/{page_id}/markdown',
        },
      }
      const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
        model: 'jev-1.13.0',
        answers: {
          document_0_question_0: { type: 'noul', noul: 0.92 },
          document_0_question_1: {
            type: 'score',
            score: 2.8,
            confidence: 0.85,
            legend: { '0': '무관', '1': '언급', '2': '부분', '3': '직접' },
            probabilities: { '0': 0, '1': 0, '2': 0.2, '3': 0.8 },
          },
        },
        usage: { input_tokens: 100, output_tokens: 12 },
      }), { status: 200 }))
      vi.stubGlobal('fetch', fetchMock)
      const previousKey = process.env.TYPESAFE_API_KEY
      process.env.TYPESAFE_API_KEY = 'test-key'

      try {
        const server = (proxy as any).server
        const handlers = server.setRequestHandler.mock.calls.flatMap((x: unknown[]) => x).filter((x: unknown) => typeof x === 'function')
        const callToolHandler = handlers[1]
        const result = await callToolHandler({
          params: {
            name: 'rank-notion-documents',
            arguments: {
              keywords: ['배포 승인'],
              questions: [
                {
                  id: 'contains_approval',
                  type: 'noul',
                  instructions: '승인 절차를 직접 설명하는가?',
                  criteria: { true: '직접 설명', false: '설명하지 않음' },
                  top_k: 5,
                  min_score: 0.8,
                },
                {
                  id: 'completeness',
                  type: 'score',
                  instructions: '얼마나 충분한가?',
                  criteria: ['무관', '언급', '부분', '직접'],
                  top_k: 1,
                  min_score: 2,
                },
              ],
            },
          },
        })

        expect(JSON.parse(result.content[0].text)).toEqual({
          contains_approval: [
            { page_id: 'page-1', title: '운영 배포 가이드', url: 'https://notion.so/page-1', score: 0.92 },
          ],
          completeness: [
            { page_id: 'page-1', title: '운영 배포 가이드', url: 'https://notion.so/page-1', score: 2.8, confidence: 0.85 },
          ],
        })
      } finally {
        if (previousKey === undefined) delete process.env.TYPESAFE_API_KEY
        else process.env.TYPESAFE_API_KEY = previousKey
        vi.unstubAllGlobals()
      }
    })

    it('deduplicates keyword searches before Markdown retrieval and retains multi-keyword pages first', async () => {
      const mockResponse = (data: unknown) => ({
        data,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
      })
      const retrievedPageIds: string[] = []
      ;(HttpClient.prototype.executeOperation as ReturnType<typeof vi.fn>).mockImplementation(
        async (operation: { operationId: string }, params: Record<string, unknown>) => {
          if (operation.operationId === 'post-search') {
            if (params.query === 'alpha') {
              return mockResponse({
                results: [
                  { object: 'page', id: 'page-first' },
                  { object: 'page', id: 'page-common' },
                ],
              })
            }
            expect(params.query).toBe('beta')
            return mockResponse({
              results: [
                { object: 'page', id: 'page-common' },
                { object: 'page', id: 'page-later' },
              ],
            })
          }
          expect(operation.operationId).toBe('retrieve-page-markdown')
          const pageId = params.page_id as string
          retrievedPageIds.push(pageId)
          return mockResponse({ markdown: `# ${pageId}`, truncated: false })
        },
      )
      ;(proxy as any).openApiLookup = {
        'API-post-search': { operationId: 'post-search', responses: {}, method: 'post', path: '/search' },
        'API-retrieve-page-markdown': {
          operationId: 'retrieve-page-markdown', responses: {}, method: 'get', path: '/pages/{page_id}/markdown',
        },
      }
      const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
        model: 'jev-1.13.0',
        answers: {
          document_0_question_0: { type: 'noul', noul: 0.9 },
          document_1_question_0: { type: 'noul', noul: 0.8 },
        },
        usage: { input_tokens: 100, output_tokens: 12 },
      }), { status: 200 }))
      vi.stubGlobal('fetch', fetchMock)
      const previousKey = process.env.TYPESAFE_API_KEY
      process.env.TYPESAFE_API_KEY = 'test-key'

      try {
        const server = (proxy as any).server
        const handlers = server.setRequestHandler.mock.calls.flatMap((x: unknown[]) => x).filter((x: unknown) => typeof x === 'function')
        const callToolHandler = handlers[1]
        const result = await callToolHandler({
          params: {
            name: 'rank-notion-documents',
            arguments: {
              keywords: ['alpha', 'beta'],
              candidate_limit: 2,
              questions: [{
                id: 'relevant',
                type: 'noul',
                instructions: 'Is this relevant?',
                criteria: { true: 'Relevant', false: 'Not relevant' },
              }],
            },
          },
        })

        expect(retrievedPageIds).toEqual(['page-common', 'page-first'])
        expect(JSON.parse(result.content[0].text)).toEqual({
          relevant: [
            { page_id: 'page-common', score: 0.9 },
            { page_id: 'page-first', score: 0.8 },
          ],
        })
      } finally {
        if (previousKey === undefined) delete process.env.TYPESAFE_API_KEY
        else process.env.TYPESAFE_API_KEY = previousKey
        vi.unstubAllGlobals()
      }
    })

    it('should execute operation and return formatted response', async () => {
      // Mock HttpClient response
      const mockResponse = {
        data: { message: 'success' },
        status: 200,
        headers: new Headers({
          'content-type': 'application/json',
        }),
      }
      ;(HttpClient.prototype.executeOperation as ReturnType<typeof vi.fn>).mockResolvedValue(mockResponse)

      // Set up the openApiLookup with our test operation
      ;(proxy as any).openApiLookup = {
        'API-getTest': {
          operationId: 'getTest',
          responses: { '200': { description: 'Success' } },
          method: 'get',
          path: '/test',
        },
      }

      const server = (proxy as any).server
      const handlers = server.setRequestHandler.mock.calls.flatMap((x: unknown[]) => x).filter((x: unknown) => typeof x === 'function')
      const callToolHandler = handlers[1]

      const result = await callToolHandler({
        params: {
          name: 'API-getTest',
          arguments: {},
        },
      })

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: JSON.stringify({ message: 'success' }),
          },
        ],
      })
    })

    it('should throw error for non-existent operation', async () => {
      const server = (proxy as any).server
      const handlers = server.setRequestHandler.mock.calls.flatMap((x: unknown[]) => x).filter((x: unknown) => typeof x === 'function')
      const callToolHandler = handlers[1]

      await expect(
        callToolHandler({
          params: {
            name: 'nonExistentMethod',
            arguments: {},
          },
        }),
      ).rejects.toThrow('Method nonExistentMethod not found')
    })

    it('should handle tool names exceeding 64 characters', async () => {
      // Mock HttpClient response
      const mockResponse = {
        data: { message: 'success' },
        status: 200,
        headers: new Headers({
          'content-type': 'application/json'
        })
      };
      (HttpClient.prototype.executeOperation as ReturnType<typeof vi.fn>).mockResolvedValue(mockResponse);

      // Set up the openApiLookup with a long tool name
      const longToolName = 'a'.repeat(65)
      const truncatedToolName = longToolName.slice(0, 64)
      ;(proxy as any).openApiLookup = {
        [truncatedToolName]: {
          operationId: longToolName,
          responses: { '200': { description: 'Success' } },
          method: 'get',
          path: '/test'
        }
      };

      const server = (proxy as any).server;
      const handlers = server.setRequestHandler.mock.calls.flatMap((x: unknown[]) => x).filter((x: unknown) => typeof x === 'function');
      const callToolHandler = handlers[1];

      const result = await callToolHandler({
        params: {
          name: truncatedToolName,
          arguments: {}
        }
      })

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: JSON.stringify({ message: 'success' })
          }
        ]
      })
    })
  })

  describe('getContentType', () => {
    it('should return correct content type for different headers', () => {
      const getContentType = (proxy as any).getContentType.bind(proxy)

      expect(getContentType(new Headers({ 'content-type': 'text/plain' }))).toBe('text')
      expect(getContentType(new Headers({ 'content-type': 'application/json' }))).toBe('text')
      expect(getContentType(new Headers({ 'content-type': 'image/jpeg' }))).toBe('image')
      expect(getContentType(new Headers({ 'content-type': 'application/octet-stream' }))).toBe('binary')
      expect(getContentType(new Headers())).toBe('binary')
    })
  })

  describe('parseHeadersFromEnv', () => {
    const originalEnv = process.env

    beforeEach(() => {
      process.env = { ...originalEnv }
    })

    afterEach(() => {
      process.env = originalEnv
    })

    it('should parse valid JSON headers from env', () => {
      process.env.OPENAPI_MCP_HEADERS = JSON.stringify({
        Authorization: 'Bearer token123',
        'X-Custom-Header': 'test',
      })

      const proxy = new MCPProxy('test-proxy', mockOpenApiSpec)
      expect(HttpClient).toHaveBeenCalledWith(
        expect.objectContaining({
          headers: {
            Authorization: 'Bearer token123',
            'X-Custom-Header': 'test',
          },
        }),
        expect.anything(),
      )
    })

    it('should return empty object when env var is not set', () => {
      delete process.env.OPENAPI_MCP_HEADERS

      const proxy = new MCPProxy('test-proxy', mockOpenApiSpec)
      expect(HttpClient).toHaveBeenCalledWith(
        expect.objectContaining({
          headers: {},
        }),
        expect.anything(),
      )
    })

    it('should return empty object and warn on invalid JSON', () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      process.env.OPENAPI_MCP_HEADERS = 'invalid json'

      const proxy = new MCPProxy('test-proxy', mockOpenApiSpec)
      expect(HttpClient).toHaveBeenCalledWith(
        expect.objectContaining({
          headers: {},
        }),
        expect.anything(),
      )
      expect(consoleSpy).toHaveBeenCalledWith('Failed to parse OPENAPI_MCP_HEADERS environment variable:', expect.any(Error))
      consoleSpy.mockRestore()
    })

    it('should return empty object and warn on non-object JSON', () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      process.env.OPENAPI_MCP_HEADERS = '"string"'

      const proxy = new MCPProxy('test-proxy', mockOpenApiSpec)
      expect(HttpClient).toHaveBeenCalledWith(
        expect.objectContaining({
          headers: {},
        }),
        expect.anything(),
      )
      expect(consoleSpy).toHaveBeenCalledWith('OPENAPI_MCP_HEADERS environment variable must be a JSON object, got:', 'string')
      consoleSpy.mockRestore()
    })

    it('should use NOTION_TOKEN when OPENAPI_MCP_HEADERS is not set', () => {
      delete process.env.OPENAPI_MCP_HEADERS
      process.env.NOTION_TOKEN = 'ntn_test_token_123'

      const proxy = new MCPProxy('test-proxy', mockOpenApiSpec)
      // Notion-Version is no longer hardcoded here; it is sourced per-operation
      // from the OpenAPI spec by HttpClient.
      expect(HttpClient).toHaveBeenCalledWith(
        expect.objectContaining({
          headers: {
            'Authorization': 'Bearer ntn_test_token_123',
          },
        }),
        expect.anything(),
      )
    })

    it('should prioritize OPENAPI_MCP_HEADERS over NOTION_TOKEN when both are set', () => {
      process.env.OPENAPI_MCP_HEADERS = JSON.stringify({
        Authorization: 'Bearer custom_token',
        'Custom-Header': 'custom_value',
      })
      process.env.NOTION_TOKEN = 'ntn_test_token_123'

      const proxy = new MCPProxy('test-proxy', mockOpenApiSpec)
      expect(HttpClient).toHaveBeenCalledWith(
        expect.objectContaining({
          headers: {
            Authorization: 'Bearer custom_token',
            'Custom-Header': 'custom_value',
          },
        }),
        expect.anything(),
      )
    })

    it('should return empty object when neither OPENAPI_MCP_HEADERS nor NOTION_TOKEN are set', () => {
      delete process.env.OPENAPI_MCP_HEADERS
      delete process.env.NOTION_TOKEN

      const proxy = new MCPProxy('test-proxy', mockOpenApiSpec)
      expect(HttpClient).toHaveBeenCalledWith(
        expect.objectContaining({
          headers: {},
        }),
        expect.anything(),
      )
    })

    it('should use NOTION_TOKEN when OPENAPI_MCP_HEADERS is empty object', () => {
      process.env.OPENAPI_MCP_HEADERS = '{}'
      process.env.NOTION_TOKEN = 'ntn_test_token_123'

      const proxy = new MCPProxy('test-proxy', mockOpenApiSpec)
      expect(HttpClient).toHaveBeenCalledWith(
        expect.objectContaining({
          headers: {
            'Authorization': 'Bearer ntn_test_token_123',
          },
        }),
        expect.anything(),
      )
    })
  })
  describe('explicit headers (per-request token passthrough)', () => {
    const originalEnv = process.env

    beforeEach(() => {
      process.env = { ...originalEnv }
    })

    afterEach(() => {
      process.env = originalEnv
    })

    it('uses explicit headers instead of the environment when provided', () => {
      process.env.NOTION_TOKEN = 'ntn_env_token_should_be_ignored'

      const headers = {
        Authorization: 'Bearer ntn_per_request_token',
        'Notion-Version': '2025-09-03',
      }
      const proxy = new MCPProxy('test-proxy', mockOpenApiSpec, headers)
      expect(HttpClient).toHaveBeenCalledWith(
        expect.objectContaining({ headers }),
        expect.anything(),
      )
    })

    it('falls back to the environment when headers are omitted', () => {
      process.env.NOTION_TOKEN = 'ntn_env_token_123'
      delete process.env.OPENAPI_MCP_HEADERS

      const proxy = new MCPProxy('test-proxy', mockOpenApiSpec)
      expect(HttpClient).toHaveBeenCalledWith(
        expect.objectContaining({
          headers: {
            Authorization: 'Bearer ntn_env_token_123',
          },
        }),
        expect.anything(),
      )
    })
  })

  describe('connect', () => {
    it('should connect to transport', async () => {
      const mockTransport = {} as Transport
      await proxy.connect(mockTransport)

      const server = (proxy as any).server
      expect(server.connect).toHaveBeenCalledWith(mockTransport)
    })
  })

  describe('string-encoded object params deserialized in handler (issue #208)', () => {
    let callToolHandler: Function

    beforeEach(() => {
      const server = (proxy as any).server
      const handlers = server.setRequestHandler.mock.calls
        .flatMap((x: unknown[]) => x)
        .filter((x: unknown) => typeof x === 'function')
      callToolHandler = handlers[1]
    })

    it('should handle notion-create-a-page parent provided as a JSON string', async () => {
      const mockResponse = {
        data: { id: 'new-page-id' },
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
      }
      ;(HttpClient.prototype.executeOperation as ReturnType<typeof vi.fn>).mockResolvedValue(mockResponse)

      ;(proxy as any).openApiLookup = {
        'notion-create-a-page': {
          operationId: 'notion-create-a-page',
          responses: { '200': { description: 'Success' } },
          method: 'post',
          path: '/pages',
        },
      }

      // Claude Desktop ≥ v1.1.3189 sends object params as JSON strings
      const parentAsString = JSON.stringify({ database_id: 'abc123' })

      // Should not throw in this handler-level test
      await expect(
        callToolHandler({
          params: {
            name: 'notion-create-a-page',
            arguments: { parent: parentAsString },
          },
        }),
      ).resolves.toBeDefined()

      // deserializeParams should have converted it back to an object
      expect(HttpClient.prototype.executeOperation).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          parent: { database_id: 'abc123' },
        }),
      )
    })

    it('should still work when notion-create-a-page parent is already an object (backward compatible)', async () => {
      const mockResponse = {
        data: { id: 'new-page-id' },
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
      }
      ;(HttpClient.prototype.executeOperation as ReturnType<typeof vi.fn>).mockResolvedValue(mockResponse)

      ;(proxy as any).openApiLookup = {
        'notion-create-a-page': {
          operationId: 'notion-create-a-page',
          responses: { '200': { description: 'Success' } },
          method: 'post',
          path: '/pages',
        },
      }

      await expect(
        callToolHandler({
          params: {
            name: 'notion-create-a-page',
            arguments: { parent: { database_id: 'abc123' } },
          },
        }),
      ).resolves.toBeDefined()

      expect(HttpClient.prototype.executeOperation).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          parent: { database_id: 'abc123' },
        }),
      )
    })

    it('should handle notion-update-page data provided as a JSON string', async () => {
      const mockResponse = {
        data: { id: 'updated-page-id' },
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
      }
      ;(HttpClient.prototype.executeOperation as ReturnType<typeof vi.fn>).mockResolvedValue(mockResponse)

      ;(proxy as any).openApiLookup = {
        'notion-update-page': {
          operationId: 'notion-update-page',
          responses: { '200': { description: 'Success' } },
          method: 'patch',
          path: '/pages/{page_id}',
        },
      }

      const dataAsString = JSON.stringify({ properties: { Status: { select: { name: 'Done' } } } })

      await expect(
        callToolHandler({
          params: {
            name: 'notion-update-page',
            arguments: { data: dataAsString },
          },
        }),
      ).resolves.toBeDefined()

      expect(HttpClient.prototype.executeOperation).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          data: { properties: { Status: { select: { name: 'Done' } } } },
        }),
      )
    })

    it('should call deserializeParams and convert string to object before executeOperation', async () => {
      const mockResponse = {
        data: { success: true },
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
      }
      ;(HttpClient.prototype.executeOperation as ReturnType<typeof vi.fn>).mockResolvedValue(mockResponse)

      ;(proxy as any).openApiLookup = {
        'notion-move-pages': {
          operationId: 'notion-move-pages',
          responses: { '200': { description: 'Success' } },
          method: 'post',
          path: '/pages/move',
        },
      }

      const newParentAsString = JSON.stringify({ page_id: 'parent-page-id' })

      await callToolHandler({
        params: {
          name: 'notion-move-pages',
          arguments: { new_parent: newParentAsString },
        },
      })

      // Verify executeOperation received the deserialized object, not the string
      const callArgs = (HttpClient.prototype.executeOperation as ReturnType<typeof vi.fn>).mock.calls[0]
      const passedParams = callArgs[1]
      expect(typeof passedParams.new_parent).not.toBe('string')
      expect(passedParams.new_parent).toEqual({ page_id: 'parent-page-id' })
    })
  })

  describe('double-serialization fix (issue #176)', () => {
    it('should deserialize stringified JSON object parameters', async () => {
      // Mock HttpClient response
      const mockResponse = {
        data: { message: 'success' },
        status: 200,
        headers: new Headers({
          'content-type': 'application/json',
        }),
      }
      ;(HttpClient.prototype.executeOperation as ReturnType<typeof vi.fn>).mockResolvedValue(mockResponse)

      // Set up the openApiLookup with our test operation
      ;(proxy as any).openApiLookup = {
        'API-updatePage': {
          operationId: 'updatePage',
          responses: { '200': { description: 'Success' } },
          method: 'patch',
          path: '/pages/{page_id}',
        },
      }

      const server = (proxy as any).server
      const handlers = server.setRequestHandler.mock.calls.flatMap((x: unknown[]) => x).filter((x: unknown) => typeof x === 'function')
      const callToolHandler = handlers[1]

      // Simulate double-serialized parameters (the bug from issue #176)
      const stringifiedData = JSON.stringify({
        page_id: 'test-page-id',
        command: 'update_properties',
        properties: { Status: 'Done' },
      })

      await callToolHandler({
        params: {
          name: 'API-updatePage',
          arguments: {
            data: stringifiedData, // This would normally fail with "Expected object, received string"
          },
        },
      })

      // Verify that the parameters were deserialized before being passed to executeOperation
      expect(HttpClient.prototype.executeOperation).toHaveBeenCalledWith(
        expect.anything(),
        {
          data: {
            page_id: 'test-page-id',
            command: 'update_properties',
            properties: { Status: 'Done' },
          },
        },
      )
    })

    it('should handle nested stringified JSON parameters', async () => {
      const mockResponse = {
        data: { success: true },
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
      }
      ;(HttpClient.prototype.executeOperation as ReturnType<typeof vi.fn>).mockResolvedValue(mockResponse)

      ;(proxy as any).openApiLookup = {
        'API-createPage': {
          operationId: 'createPage',
          responses: { '200': { description: 'Success' } },
          method: 'post',
          path: '/pages',
        },
      }

      const server = (proxy as any).server
      const handlers = server.setRequestHandler.mock.calls.flatMap((x: unknown[]) => x).filter((x: unknown) => typeof x === 'function')
      const callToolHandler = handlers[1]

      // Nested stringified object
      const nestedData = JSON.stringify({
        parent: JSON.stringify({ page_id: 'parent-page-id' }),
      })

      await callToolHandler({
        params: {
          name: 'API-createPage',
          arguments: {
            data: nestedData,
          },
        },
      })

      // Verify nested objects were also deserialized
      expect(HttpClient.prototype.executeOperation).toHaveBeenCalledWith(
        expect.anything(),
        {
          data: {
            parent: { page_id: 'parent-page-id' },
          },
        },
      )
    })

    it('should deserialize JSON string items within an array parameter', async () => {
      const mockResponse = {
        data: { id: 'new-page-id' },
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
      }
      ;(HttpClient.prototype.executeOperation as ReturnType<typeof vi.fn>).mockResolvedValue(mockResponse)

      ;(proxy as any).openApiLookup = {
        'API-appendBlockChildren': {
          operationId: 'appendBlockChildren',
          responses: { '200': { description: 'Success' } },
          method: 'patch',
          path: '/blocks/{block_id}/children',
        },
      }

      const server = (proxy as any).server
      const handlers = server.setRequestHandler.mock.calls.flatMap((x: unknown[]) => x).filter((x: unknown) => typeof x === 'function')
      const callToolHandler = handlers[1]

      // Claude Desktop sends each array item as a JSON string
      const block1 = JSON.stringify({ object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: 'Hello' } }] } })
      const block2 = JSON.stringify({ object: 'block', type: 'heading_1', heading_1: { rich_text: [{ type: 'text', text: { content: 'Title' } }] } })

      await callToolHandler({
        params: {
          name: 'API-appendBlockChildren',
          arguments: {
            children: [block1, block2],
          },
        },
      })

      expect(HttpClient.prototype.executeOperation).toHaveBeenCalledWith(
        expect.anything(),
        {
          children: [
            { object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: 'Hello' } }] } },
            { object: 'block', type: 'heading_1', heading_1: { rich_text: [{ type: 'text', text: { content: 'Title' } }] } },
          ],
        },
      )
    })

    it('should pass through an array of proper objects unchanged', async () => {
      const mockResponse = {
        data: { id: 'new-page-id' },
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
      }
      ;(HttpClient.prototype.executeOperation as ReturnType<typeof vi.fn>).mockResolvedValue(mockResponse)

      ;(proxy as any).openApiLookup = {
        'API-appendBlockChildren': {
          operationId: 'appendBlockChildren',
          responses: { '200': { description: 'Success' } },
          method: 'patch',
          path: '/blocks/{block_id}/children',
        },
      }

      const server = (proxy as any).server
      const handlers = server.setRequestHandler.mock.calls.flatMap((x: unknown[]) => x).filter((x: unknown) => typeof x === 'function')
      const callToolHandler = handlers[1]

      const block1 = { object: 'block', type: 'paragraph' }
      const block2 = { object: 'block', type: 'heading_1' }

      await callToolHandler({
        params: {
          name: 'API-appendBlockChildren',
          arguments: {
            children: [block1, block2],
          },
        },
      })

      expect(HttpClient.prototype.executeOperation).toHaveBeenCalledWith(
        expect.anything(),
        { children: [block1, block2] },
      )
    })

    it('should handle a mixed array with both string items and object items', async () => {
      const mockResponse = {
        data: { success: true },
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
      }
      ;(HttpClient.prototype.executeOperation as ReturnType<typeof vi.fn>).mockResolvedValue(mockResponse)

      ;(proxy as any).openApiLookup = {
        'API-appendBlockChildren': {
          operationId: 'appendBlockChildren',
          responses: { '200': { description: 'Success' } },
          method: 'patch',
          path: '/blocks/{block_id}/children',
        },
      }

      const server = (proxy as any).server
      const handlers = server.setRequestHandler.mock.calls.flatMap((x: unknown[]) => x).filter((x: unknown) => typeof x === 'function')
      const callToolHandler = handlers[1]

      const blockAsString = JSON.stringify({ object: 'block', type: 'paragraph' })
      const blockAsObject = { object: 'block', type: 'heading_1' }

      await callToolHandler({
        params: {
          name: 'API-appendBlockChildren',
          arguments: {
            children: [blockAsString, blockAsObject],
          },
        },
      })

      expect(HttpClient.prototype.executeOperation).toHaveBeenCalledWith(
        expect.anything(),
        {
          children: [
            { object: 'block', type: 'paragraph' },
            { object: 'block', type: 'heading_1' },
          ],
        },
      )
    })

    it('should preserve non-JSON string items within arrays', async () => {
      const mockResponse = {
        data: { success: true },
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
      }
      ;(HttpClient.prototype.executeOperation as ReturnType<typeof vi.fn>).mockResolvedValue(mockResponse)

      ;(proxy as any).openApiLookup = {
        'API-search': {
          operationId: 'search',
          responses: { '200': { description: 'Success' } },
          method: 'post',
          path: '/search',
        },
      }

      const server = (proxy as any).server
      const handlers = server.setRequestHandler.mock.calls.flatMap((x: unknown[]) => x).filter((x: unknown) => typeof x === 'function')
      const callToolHandler = handlers[1]

      await callToolHandler({
        params: {
          name: 'API-search',
          arguments: {
            tags: ['hello', 'world', '{ not valid json }'],
          },
        },
      })

      expect(HttpClient.prototype.executeOperation).toHaveBeenCalledWith(
        expect.anything(),
        { tags: ['hello', 'world', '{ not valid json }'] },
      )
    })

    it('should preserve non-JSON string parameters', async () => {
      const mockResponse = {
        data: { success: true },
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
      }
      ;(HttpClient.prototype.executeOperation as ReturnType<typeof vi.fn>).mockResolvedValue(mockResponse)

      ;(proxy as any).openApiLookup = {
        'API-search': {
          operationId: 'search',
          responses: { '200': { description: 'Success' } },
          method: 'post',
          path: '/search',
        },
      }

      const server = (proxy as any).server
      const handlers = server.setRequestHandler.mock.calls.flatMap((x: unknown[]) => x).filter((x: unknown) => typeof x === 'function')
      const callToolHandler = handlers[1]

      await callToolHandler({
        params: {
          name: 'API-search',
          arguments: {
            query: 'hello world', // Regular string, should NOT be parsed
            filter: '{ not valid json }', // Looks like JSON but isn't valid
          },
        },
      })

      // Verify that non-JSON strings are preserved as-is
      expect(HttpClient.prototype.executeOperation).toHaveBeenCalledWith(
        expect.anything(),
        {
          query: 'hello world',
          filter: '{ not valid json }',
        },
      )
    })

    it('should handle API-create-a-comment parent provided as a JSON string', async () => {
      const mockResponse = {
        data: { id: 'new-comment-id' },
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
      }
      ;(HttpClient.prototype.executeOperation as ReturnType<typeof vi.fn>).mockResolvedValue(mockResponse)

      ;(proxy as any).openApiLookup = {
        'API-create-a-comment': {
          operationId: 'create-a-comment',
          responses: { '200': { description: 'Success' } },
          method: 'post',
          path: '/comments',
        },
      }

      const server = (proxy as any).server
      const handlers = server.setRequestHandler.mock.calls.flatMap((x: unknown[]) => x).filter((x: unknown) => typeof x === 'function')
      const callToolHandler = handlers[1]

      // Some clients double-encode `parent` as a JSON string. Forwarding that to
      // the Notion API makes it throw on `"block_id" in <string>` and return a
      // 500, so deserialize it back to an object first.
      const parentAsString = JSON.stringify({ page_id: '3870bb29-1a64-816b-8641-c87ca28062d0' })

      await expect(
        callToolHandler({
          params: {
            name: 'API-create-a-comment',
            arguments: {
              parent: parentAsString,
              rich_text: [{ text: { content: 'Hello' } }],
            },
          },
        }),
      ).resolves.toBeDefined()

      expect(HttpClient.prototype.executeOperation).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          parent: { page_id: '3870bb29-1a64-816b-8641-c87ca28062d0' },
        }),
      )
    })

    it('should deserialize a stringified object nested inside an array element object', async () => {
      const mockResponse = {
        data: { id: 'new-page-id' },
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
      }
      ;(HttpClient.prototype.executeOperation as ReturnType<typeof vi.fn>).mockResolvedValue(mockResponse)

      ;(proxy as any).openApiLookup = {
        'API-appendBlockChildren': {
          operationId: 'appendBlockChildren',
          responses: { '200': { description: 'Success' } },
          method: 'patch',
          path: '/blocks/{block_id}/children',
        },
      }

      const server = (proxy as any).server
      const handlers = server.setRequestHandler.mock.calls.flatMap((x: unknown[]) => x).filter((x: unknown) => typeof x === 'function')
      const callToolHandler = handlers[1]

      // The array element is a real object, but one of its properties is itself
      // a stringified object. The previous shallow array handling left this as a
      // string; the uniform recursive walk now normalizes it.
      const children = [
        {
          object: 'block',
          type: 'paragraph',
          paragraph: JSON.stringify({ rich_text: [{ type: 'text', text: { content: 'Hello' } }] }),
        },
      ]

      await callToolHandler({
        params: {
          name: 'API-appendBlockChildren',
          arguments: { children },
        },
      })

      expect(HttpClient.prototype.executeOperation).toHaveBeenCalledWith(
        expect.anything(),
        {
          children: [
            {
              object: 'block',
              type: 'paragraph',
              paragraph: { rich_text: [{ type: 'text', text: { content: 'Hello' } }] },
            },
          ],
        },
      )
    })

    it('should deserialize a double-stringified parent', async () => {
      const mockResponse = {
        data: { id: 'new-comment-id' },
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
      }
      ;(HttpClient.prototype.executeOperation as ReturnType<typeof vi.fn>).mockResolvedValue(mockResponse)

      ;(proxy as any).openApiLookup = {
        'API-create-a-comment': {
          operationId: 'create-a-comment',
          responses: { '200': { description: 'Success' } },
          method: 'post',
          path: '/comments',
        },
      }

      const server = (proxy as any).server
      const handlers = server.setRequestHandler.mock.calls.flatMap((x: unknown[]) => x).filter((x: unknown) => typeof x === 'function')
      const callToolHandler = handlers[1]

      // A client that serialized `parent` twice: JSON.stringify(JSON.stringify(parent)).
      const doubleEncodedParent = JSON.stringify(JSON.stringify({ page_id: '3870bb29-1a64-816b-8641-c87ca28062d0' }))

      await callToolHandler({
        params: {
          name: 'API-create-a-comment',
          arguments: {
            parent: doubleEncodedParent,
            rich_text: [{ text: { content: 'Hello' } }],
          },
        },
      })

      expect(HttpClient.prototype.executeOperation).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          parent: { page_id: '3870bb29-1a64-816b-8641-c87ca28062d0' },
        }),
      )
    })

    it('should not coerce scalar or quoted-scalar string params', async () => {
      const mockResponse = {
        data: { success: true },
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
      }
      ;(HttpClient.prototype.executeOperation as ReturnType<typeof vi.fn>).mockResolvedValue(mockResponse)

      ;(proxy as any).openApiLookup = {
        'API-search': {
          operationId: 'search',
          responses: { '200': { description: 'Success' } },
          method: 'post',
          path: '/search',
        },
      }

      const server = (proxy as any).server
      const handlers = server.setRequestHandler.mock.calls.flatMap((x: unknown[]) => x).filter((x: unknown) => typeof x === 'function')
      const callToolHandler = handlers[1]

      await callToolHandler({
        params: {
          name: 'API-search',
          arguments: {
            // Looks like JSON scalars, but the schema wants strings: keep as-is
            // rather than coercing to number/boolean or unwrapping the quotes.
            count: '123',
            flag: 'true',
            quoted: '"hello"',
          },
        },
      })

      expect(HttpClient.prototype.executeOperation).toHaveBeenCalledWith(
        expect.anything(),
        { count: '123', flag: 'true', quoted: '"hello"' },
      )
    })
  })
})
