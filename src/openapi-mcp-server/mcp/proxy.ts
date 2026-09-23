import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema, JSONRPCResponse, ListToolsRequestSchema, Tool } from '@modelcontextprotocol/sdk/types.js'
import { JSONSchema7 as IJsonSchema } from 'json-schema'
import { OpenAPIToMCPConverter } from '../openapi/parser'
import { HttpClient, HttpClientError } from '../client/http-client'
import { OpenAPIV3 } from 'openapi-types'
import { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { JevClient, JevClientError } from '../../jev/client'
import { JevDocumentRanker, RankingQuestion } from '../../jev/document-ranker'
import { JevSectionLocator, SectionCandidate } from '../../jev/section-locator'
import { internalFileUploadOperations, uploadNotionAttachment } from './notion-attachment'

const RANK_NOTION_DOCUMENTS_TOOL = 'rank-notion-documents'
const FIND_NOTION_SECTIONS_TOOL = 'find-notion-sections'
const GET_NOTION_HEADING_TREE_TOOL = 'get-notion-heading-tree'
const GET_NOTION_SECTION_CONTENT_TOOL = 'get-notion-section-content'
const UPLOAD_NOTION_ATTACHMENT_TOOL = 'upload-notion-attachment'

const uploadNotionAttachmentTool: Tool = {
  name: UPLOAD_NOTION_ATTACHMENT_TOOL,
  description: 'Upload a local file or image and attach it to a Notion page or block. A .html/.htm file or inline html_content becomes an interactive HTML embed block.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      parent_id: { type: 'string', minLength: 1, description: 'Page or block ID that will receive the new child block.' },
      file_path: { type: 'string', minLength: 1, description: 'Absolute path to a file on the MCP server host.' },
      html_content: { type: 'string', minLength: 1, description: 'Inline HTML to upload and attach as an HTML block.' },
      kind: { type: 'string', enum: ['file', 'image', 'html'], description: 'Optional block kind; inferred from the file extension when omitted.' },
      after: { type: 'string', minLength: 1, description: 'Optional sibling block ID after which to append.' },
    },
    required: ['parent_id'],
    oneOf: [
      { required: ['file_path'] },
      { required: ['html_content'] },
    ],
  },
  annotations: { title: 'Upload Notion Attachment', destructiveHint: true },
}

const rankNotionDocumentsTool: Tool = {
  name: RANK_NOTION_DOCUMENTS_TOOL,
  description:
    'Search Notion page titles using one or more keywords, then evaluate each retained page’s full content with one or more Jev Noul or Score questions. ' +
    'Returns one score-sorted page list per question without returning page bodies to the LLM.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      keywords: {
        type: 'array',
        minItems: 1,
        maxItems: 20,
        description: 'Minimal keywords used only to collect candidate pages from Notion title searches.',
        items: { type: 'string', minLength: 1 },
      },
      candidate_limit: {
        type: 'integer',
        minimum: 1,
        maximum: 100,
        default: 50,
        description: 'Maximum number of unique candidate pages whose Markdown is retrieved and evaluated by Jev. Pages found by more keywords are retained first.',
      },
      questions: {
        type: 'array',
        minItems: 1,
        maxItems: 20,
        description: 'Independent Jev Noul or Score questions applied to every candidate page.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', minLength: 1, description: 'Unique key for this question’s output list.' },
            type: { type: 'string', enum: ['noul', 'score'], description: 'Jev question type.' },
            instructions: { type: 'string', minLength: 1, description: 'Question evaluated against each page.' },
            criteria: {
              description: 'For Noul, an object with true and false descriptions. For Score, 2–10 ordered level descriptions.',
              oneOf: [
                {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    true: { type: 'string', minLength: 1 },
                    false: { type: 'string', minLength: 1 },
                  },
                  required: ['true', 'false'],
                },
                {
                  type: 'array',
                  minItems: 2,
                  maxItems: 10,
                  items: { type: 'string', minLength: 1 },
                },
              ],
            },
            top_k: { type: 'integer', minimum: 1, maximum: 100, default: 10 },
            min_score: {
              type: 'number',
              minimum: 0,
              description: 'Optional raw-score threshold: 0–1 for Noul; 0–criteria.length - 1 for Score.',
            },
          },
          required: ['id', 'type', 'instructions', 'criteria'],
        },
      },
    },
    required: ['keywords', 'questions'],
  },
  annotations: {
    title: 'Rank Notion Documents',
    readOnlyHint: true,
  },
}

type RankNotionDocumentsArguments = {
  keywords: string[]
  candidateLimit: number
  questions: RankingQuestion[]
}

const findNotionSectionsTool: Tool = {
  name: FIND_NOTION_SECTIONS_TOOL,
  description:
    'Locate answer-bearing Heading sections inside multiple known Notion pages. It reads each Notion block tree, then uses Jev Choice to select the most relevant non-overlapping Heading section for the same question in every page.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      page_ids: {
        type: 'array',
        minItems: 1,
        maxItems: 100,
        description: 'Notion page IDs, normally selected from rank-notion-documents results.',
        items: { type: 'string', minLength: 1 },
      },
      question: {
        type: 'string',
        minLength: 1,
        description: 'The same answer-location question applied to every supplied page.',
      },
      top_k: {
        type: 'integer',
        minimum: 1,
        maximum: 20,
        default: 3,
        description: 'Maximum matching Heading sections returned per page.',
      },
    },
    required: ['page_ids', 'question'],
  },
  annotations: {
    title: 'Find Notion Sections',
    readOnlyHint: true,
  },
}

type FindNotionSectionsArguments = {
  pageIds: string[]
  question: string
  topK: number
}

const getNotionHeadingTreeTool: Tool = {
  name: GET_NOTION_HEADING_TREE_TOOL,
  description: 'Return the logical Heading hierarchy of one Notion page without returning its body content.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      page_id: { type: 'string', minLength: 1, description: 'Notion page ID.' },
    },
    required: ['page_id'],
  },
  annotations: {
    title: 'Get Notion Heading Tree',
    readOnlyHint: true,
  },
}

const getNotionSectionContentTool: Tool = {
  name: GET_NOTION_SECTION_CONTENT_TOOL,
  description: 'Return Markdown for one logical Heading section of a Notion page, including lower-level Heading sections and nested Notion children.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      page_id: { type: 'string', minLength: 1, description: 'Notion page ID.' },
      heading_id: {
        type: ['string', 'null'],
        description: 'Heading block ID from get-notion-heading-tree or find-notion-sections. Use null for content before the first Heading.',
      },
    },
    required: ['page_id', 'heading_id'],
  },
  annotations: {
    title: 'Get Notion Section Content',
    readOnlyHint: true,
  },
}

type GetNotionSectionContentArguments = {
  pageId: string
  headingId: string | null
}

type NotionBlockNode = {
  id: string
  type: string
  raw: Record<string, unknown>
  content: string
  children: NotionBlockNode[]
}

type HeadingContext = {
  id: string
  level: number
  text: string
}

type NotionHeading = {
  block_id: string
  level: number
  text: string
  parent_heading_id: string | null
  heading_path: string[]
}

type PathItemObject = OpenAPIV3.PathItemObject & {
  get?: OpenAPIV3.OperationObject
  put?: OpenAPIV3.OperationObject
  post?: OpenAPIV3.OperationObject
  delete?: OpenAPIV3.OperationObject
  patch?: OpenAPIV3.OperationObject
}

type NewToolDefinition = {
  methods: Array<{
    name: string
    description: string
    inputSchema: IJsonSchema & { type: 'object' }
    returnSchema?: IJsonSchema
  }>
}

/**
 * Recursively deserialize stringified JSON values in parameters.
 * This handles the case where MCP clients (like Cursor, Claude Code, and some
 * SDKs) double-serialize nested object/array parameters, sending them as JSON
 * strings instead of structured values.
 *
 * The whole argument tree is walked uniformly: every object property and every
 * array element is visited, JSON-looking strings are decoded, and the decoded
 * result is walked again. This normalizes deeply nested cases — including a
 * stringified object that sits inside an array element object (e.g.
 * `{ children: [{ paragraph: '{"rich_text":[...]}' }] }`) and values that were
 * JSON-encoded more than once (e.g. `JSON.stringify(JSON.stringify(parent))`) —
 * before the request is forwarded to the Notion API.
 *
 * @see https://github.com/makenotion/notion-mcp-server/issues/176
 */
function deserializeParams(params: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(params)) {
    result[key] = deserializeValue(value)
  }
  return result
}

/**
 * Normalize a single value: decode a JSON-encoded string into the structured
 * value it represents (recursing into the result), walk into every array
 * element, and walk into every nested object property. Non-JSON strings and
 * scalars are returned unchanged, so values the schema legitimately wants as
 * strings (and numbers/booleans encoded as strings) are left intact.
 */
function deserializeValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return unwrapJsonString(value)
  }

  if (Array.isArray(value)) {
    return value.map(deserializeValue)
  }

  if (typeof value === 'object' && value !== null) {
    const result: Record<string, unknown> = {}
    for (const [key, nested] of Object.entries(value)) {
      result[key] = deserializeValue(nested)
    }
    return result
  }

  return value
}

// Bound how many JSON-decode passes we attempt on a single string. One pass
// handles the common single-encoding; extra passes absorb double/triple
// serialization without unbounded work on adversarial input.
const MAX_UNWRAP_DEPTH = 3

/**
 * Resolve a (possibly multiply-)JSON-encoded string to the object or array it
 * represents. Only strings that ultimately decode to an object or array are
 * transformed (and then recursively normalized); a string that decodes to a
 * scalar (number/boolean/null) or to another plain string is returned
 * unchanged, so genuine string values are never corrupted.
 */
function unwrapJsonString(value: string): unknown {
  let current = value
  for (let depth = 0; depth < MAX_UNWRAP_DEPTH; depth++) {
    const trimmed = current.trim()
    // Only attempt a parse when the string could encode an object/array
    // (`{...}`/`[...]`) or wrap one in a JSON string literal (`"..."`). This
    // skips the common case of ordinary text without touching JSON.parse.
    const couldBeEncoded =
      (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']')) ||
      (trimmed.startsWith('"') && trimmed.endsWith('"'))
    if (!couldBeEncoded) {
      break
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      break
    }

    if (typeof parsed === 'object' && parsed !== null) {
      return deserializeValue(parsed)
    }
    if (typeof parsed === 'string') {
      // Peeled one layer of JSON-string encoding; loop to see whether it wraps
      // a structured value (double-encoding).
      current = parsed
      continue
    }
    // Decoded to a scalar — not a structured value; leave the original intact.
    break
  }
  return value
}

// import this class, extend and return server
export class MCPProxy {
  private server: Server
  private httpClient: HttpClient
  private tools: Record<string, NewToolDefinition>
  private openApiLookup: Record<string, OpenAPIV3.OperationObject & { method: string; path: string }>

  /**
   * @param headers Notion API headers to authenticate with. When omitted, the
   *   headers are resolved from the environment (`OPENAPI_MCP_HEADERS` /
   *   `NOTION_TOKEN`). The HTTP transport passes per-connection headers here so a
   *   single deployment can serve multiple Notion integrations.
   */
  constructor(name: string, openApiSpec: OpenAPIV3.Document, headers?: Record<string, string>) {
    this.server = new Server({ name, version: '1.0.0' }, { capabilities: { tools: {} } })
    const baseUrl = openApiSpec.servers?.[0].url
    if (!baseUrl) {
      throw new Error('No base URL found in OpenAPI spec')
    }
    this.httpClient = new HttpClient(
      {
        baseUrl,
        headers: headers ?? this.parseHeadersFromEnv(),
      },
      openApiSpec,
    )

    // Convert OpenAPI spec to MCP tools
    const converter = new OpenAPIToMCPConverter(openApiSpec)
    const { tools, openApiLookup } = converter.convertToMCPTools()
    this.tools = tools
    this.openApiLookup = openApiLookup

    this.setupHandlers()
  }

  private setupHandlers() {
    // Handle tool listing
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const tools: Tool[] = []

      // Add methods as separate tools to match the MCP format
      Object.entries(this.tools).forEach(([toolName, def]) => {
        def.methods.forEach(method => {
          if (internalFileUploadOperations.has(method.name)) return
          const toolNameWithMethod = `${toolName}-${method.name}`;
          const truncatedToolName = this.truncateToolName(toolNameWithMethod);

          // Look up the HTTP method to determine annotations
          const operation = this.openApiLookup[toolNameWithMethod];
          const httpMethod = operation?.method?.toLowerCase();
          const isReadOnly = httpMethod === 'get';

          tools.push({
            name: truncatedToolName,
            description: method.description,
            inputSchema: method.inputSchema as Tool['inputSchema'],
            annotations: {
              title: this.operationIdToTitle(method.name),
              ...(isReadOnly
                ? { readOnlyHint: true }
                : { destructiveHint: true }),
            },
          })
        })
      })

      tools.push(rankNotionDocumentsTool)
      tools.push(findNotionSectionsTool)
      tools.push(getNotionHeadingTreeTool)
      tools.push(getNotionSectionContentTool)
      tools.push(uploadNotionAttachmentTool)

      return { tools }
    })

    // Handle tool calling
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: params } = request.params

      if (name === RANK_NOTION_DOCUMENTS_TOOL) {
        try {
          return await this.rankNotionDocuments(params)
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error'
          return {
            content: [{ type: 'text', text: JSON.stringify({ status: 'error', message }) }],
            isError: true,
          }
        }
      }

      if (name === FIND_NOTION_SECTIONS_TOOL) {
        try {
          return await this.findNotionSections(params)
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error'
          return {
            content: [{ type: 'text', text: JSON.stringify({ status: 'error', message }) }],
            isError: true,
          }
        }
      }

      if (name === GET_NOTION_HEADING_TREE_TOOL) {
        try {
          return await this.getNotionHeadingTree(params)
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error'
          return {
            content: [{ type: 'text', text: JSON.stringify({ status: 'error', message }) }],
            isError: true,
          }
        }
      }

      if (name === GET_NOTION_SECTION_CONTENT_TOOL) {
        try {
          return await this.getNotionSectionContent(params)
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error'
          return {
            content: [{ type: 'text', text: JSON.stringify({ status: 'error', message }) }],
            isError: true,
          }
        }
      }

      if (name === UPLOAD_NOTION_ATTACHMENT_TOOL) {
        try {
          const result = await uploadNotionAttachment(this.httpClient, this.openApiLookup, params)
          return { content: [{ type: 'text', text: JSON.stringify(result) }] }
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error'
          return {
            content: [{ type: 'text', text: JSON.stringify({ status: 'error', message }) }],
            isError: true,
          }
        }
      }

      if (name.startsWith('API-') && internalFileUploadOperations.has(name.slice(4))) {
        throw new Error(`Method ${name} not found`)
      }

      // Find the operation in OpenAPI spec
      const operation = this.findOperation(name)
      if (!operation) {
        throw new Error(`Method ${name} not found`)
      }

      // Deserialize any stringified JSON parameters (fixes double-serialization bug)
      // See: https://github.com/makenotion/notion-mcp-server/issues/176
      const deserializedParams = params ? deserializeParams(params as Record<string, unknown>) : {}

      try {
        // Execute the operation
        const response = await this.httpClient.executeOperation(operation, deserializedParams)

        // Convert response to MCP format
        return {
          content: [
            {
              type: 'text', // currently this is the only type that seems to be used by mcp server
              text: JSON.stringify(response.data), // TODO: pass through the http status code text?
            },
          ],
        }
      } catch (error) {
        console.error('Error in tool call', error instanceof Error ? error.message : 'Unknown error')
        if (error instanceof HttpClientError) {
          console.error('HttpClientError encountered, returning structured error', { status: error.status })
          const data = error.data?.response?.data ?? error.data ?? {}
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  status: 'error', // TODO: get this from http status code?
                  ...(typeof data === 'object' ? data : { data: data }),
                }),
              },
            ],
          }
        }
        throw error
      }
    })
  }

  /**
   * Searches Notion by title keywords, retrieves matching page Markdown inside
   * the MCP server, and applies every supplied Jev question to every page.
   * Only the compact, question-keyed result lists reach the LLM.
   */
  private async rankNotionDocuments(rawParams: unknown) {
    const args = parseRankNotionDocumentsArguments(rawParams)
    const searchOperation = this.openApiLookup['API-post-search']
    const markdownOperation = this.openApiLookup['API-retrieve-page-markdown']
    if (!searchOperation || !markdownOperation) {
      throw new Error('Required Notion search or retrieve-page-markdown operation is unavailable.')
    }

    const searchResponses = await Promise.all(args.keywords.map(keyword =>
      this.httpClient.executeOperation<unknown>(searchOperation, {
        query: keyword,
        filter: { property: 'object', value: 'page' },
        page_size: 100,
      }),
    ))
    const candidates = prioritizeSearchCandidates(
      searchResponses.map(response => parseNotionSearchResponse(response.data)),
      args.candidateLimit,
    )

    const fetched = await mapWithConcurrency(candidates, 3, async document => {
      try {
        const response = await this.httpClient.executeOperation<unknown>(markdownOperation, {
          page_id: document.id,
          include_transcript: false,
        })
        const page = parseNotionMarkdownResponse(response.data)
        return {
          status: 'ok' as const,
          document: {
            ...document,
            markdown: page.markdown,
            notionMarkdownTruncated: page.truncated,
          },
        }
      } catch (error) {
        // One inaccessible page must not block all question result lists.
        return {
          status: 'unavailable' as const,
          document,
        }
      }
    })

    const accessible = fetched.filter(
      (item): item is Extract<(typeof fetched)[number], { status: 'ok' }> => item.status === 'ok',
    )
    if (accessible.length === 0) {
      return {
        content: [{ type: 'text', text: JSON.stringify(emptyQuestionResultLists(args.questions)) }],
      }
    }

    const ranker = new JevDocumentRanker(new JevClient())
    const ranking = await ranker.rank(args.questions, accessible.map(item => item.document))

    return {
      content: [{ type: 'text', text: JSON.stringify(ranking.results) }],
    }
  }

  private async findNotionSections(rawParams: unknown) {
    const args = parseFindNotionSectionsArguments(rawParams)
    const childrenOperation = this.openApiLookup['API-get-block-children']
    if (!childrenOperation) {
      throw new Error('The Notion get-block-children operation is unavailable.')
    }

    const pages = await mapWithConcurrency(args.pageIds, 3, async pageId => {
      try {
        return {
          page_id: pageId,
          sections: await this.retrieveNotionSectionCandidates(childrenOperation, pageId),
        }
      } catch {
        // Preserve the requested page key with an empty result list if the page
        // is unavailable to the integration or cannot be read.
        return { page_id: pageId, sections: [] }
      }
    })

    const locator = new JevSectionLocator(new JevClient())
    const results = await locator.locate(args.question, pages, args.topK)
    return {
      content: [{ type: 'text', text: JSON.stringify(results) }],
    }
  }

  private async getNotionHeadingTree(rawParams: unknown) {
    const pageId = parsePageIdArguments(rawParams).pageId
    const childrenOperation = this.openApiLookup['API-get-block-children']
    if (!childrenOperation) {
      throw new Error('The Notion get-block-children operation is unavailable.')
    }
    const headings = collectNotionHeadings(await this.retrieveNotionBlockTree(childrenOperation, pageId))
    return {
      content: [{ type: 'text', text: JSON.stringify({ page_id: pageId, headings }) }],
    }
  }

  private async getNotionSectionContent(rawParams: unknown) {
    const args = parseGetNotionSectionContentArguments(rawParams)
    const childrenOperation = this.openApiLookup['API-get-block-children']
    if (!childrenOperation) {
      throw new Error('The Notion get-block-children operation is unavailable.')
    }
    const markdown = renderNotionSection(
      await this.retrieveNotionBlockTree(childrenOperation, args.pageId),
      args.headingId,
    )
    return {
      content: [{ type: 'text', text: JSON.stringify({
        page_id: args.pageId,
        heading_id: args.headingId,
        markdown,
      }) }],
    }
  }

  private async retrieveNotionSectionCandidates(
    operation: OpenAPIV3.OperationObject & { method: string; path: string },
    pageId: string,
  ): Promise<SectionCandidate[]> {
    return buildSectionCandidates(await this.retrieveNotionBlockTree(operation, pageId))
  }

  private async retrieveNotionBlockTree(
    operation: OpenAPIV3.OperationObject & { method: string; path: string },
    parentBlockId: string,
  ): Promise<NotionBlockNode[]> {
    const nodes: NotionBlockNode[] = []
    let cursor: string | undefined

    do {
      const response = await this.httpClient.executeOperation<unknown>(operation, {
        block_id: parentBlockId,
        page_size: 100,
        ...(cursor ? { start_cursor: cursor } : {}),
      })
      const page = parseNotionBlockChildrenResponse(response.data)

      for (const block of page.blocks) {
        const type = typeof block.type === 'string' ? block.type : undefined
        const id = typeof block.id === 'string' ? block.id : undefined
        if (!type || !id) continue
        // A child page/database is a link to a separate document. Do not mix
        // its title or descendants into the current page's logical sections.
        if (isChildDocumentBlock(type)) continue

        const content = extractNotionBlockText(block, type)
        const children = block.has_children === true
          ? await this.retrieveNotionBlockTree(operation, id)
          : []
        nodes.push({ id, type, raw: block, content, children })
      }

      cursor = page.hasMore ? page.nextCursor : undefined
    } while (cursor)

    return nodes
  }

  private findOperation(operationId: string): (OpenAPIV3.OperationObject & { method: string; path: string }) | null {
    return this.openApiLookup[operationId] ?? null
  }

  private parseHeadersFromEnv(): Record<string, string> {
    // First try OPENAPI_MCP_HEADERS (existing behavior)
    const headersJson = process.env.OPENAPI_MCP_HEADERS
    if (headersJson) {
      try {
        const headers = JSON.parse(headersJson)
        if (typeof headers !== 'object' || headers === null) {
          console.warn('OPENAPI_MCP_HEADERS environment variable must be a JSON object, got:', typeof headers)
        } else if (Object.keys(headers).length > 0) {
          // Only use OPENAPI_MCP_HEADERS if it contains actual headers
          return headers
        }
        // If OPENAPI_MCP_HEADERS is empty object, fall through to try NOTION_TOKEN
      } catch (error) {
        console.warn('Failed to parse OPENAPI_MCP_HEADERS environment variable:', error)
        // Fall through to try NOTION_TOKEN
      }
    }

    // Alternative: try NOTION_TOKEN
    const notionToken = process.env.NOTION_TOKEN
    if (notionToken) {
      // Notion-Version is intentionally omitted: it is sourced per-operation from
      // the OpenAPI spec by HttpClient, so endpoints can pin the version they need.
      return {
        'Authorization': `Bearer ${notionToken}`,
      }
    }

    return {}
  }

  private getContentType(headers: Headers): 'text' | 'image' | 'binary' {
    const contentType = headers.get('content-type')
    if (!contentType) return 'binary'

    if (contentType.includes('text') || contentType.includes('json')) {
      return 'text'
    } else if (contentType.includes('image')) {
      return 'image'
    }
    return 'binary'
  }

  private truncateToolName(name: string): string {
    if (name.length <= 64) {
      return name;
    }
    return name.slice(0, 64);
  }

  /**
   * Convert an operationId like "createDatabase" to a human-readable title like "Create Database"
   */
  private operationIdToTitle(operationId: string): string {
    // Split on camelCase boundaries and capitalize each word
    return operationId
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .split(/[\s_-]+/)
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }

  async connect(transport: Transport) {
    // The SDK will handle stdio communication
    await this.server.connect(transport)
  }

  getServer() {
    return this.server
  }
}

function parseRankNotionDocumentsArguments(raw: unknown): RankNotionDocumentsArguments {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Arguments must be an object.')
  }
  const params = raw as Record<string, unknown>
  if (!Array.isArray(params.keywords) || params.keywords.length === 0 || params.keywords.length > 20) {
    throw new Error('keywords must contain between 1 and 20 keywords.')
  }
  const seenKeywords = new Set<string>()
  const keywords = params.keywords.map((value, index) => {
    const keyword = requireNonEmptyString(value, `keywords[${index}]`)
    if (seenKeywords.has(keyword)) throw new Error(`keywords contains duplicate keyword: ${keyword}.`)
    seenKeywords.add(keyword)
    return keyword
  })
  const candidateLimit = optionalPositiveInteger(params.candidate_limit, 'candidate_limit', 100) ?? 50
  if (!Array.isArray(params.questions) || params.questions.length === 0 || params.questions.length > 20) {
    throw new Error('questions must contain between 1 and 20 questions.')
  }

  const seenIds = new Set<string>()
  const questions = params.questions.map((rawQuestion, index): RankingQuestion => {
    if (!rawQuestion || typeof rawQuestion !== 'object' || Array.isArray(rawQuestion)) {
      throw new Error(`questions[${index}] must be an object.`)
    }
    const question = rawQuestion as Record<string, unknown>
    const id = requireNonEmptyString(question.id, `questions[${index}].id`)
    if (seenIds.has(id)) {
      throw new Error(`questions contains duplicate ID: ${id}.`)
    }
    seenIds.add(id)

    const type = requireQuestionType(question.type, `questions[${index}].type`)
    const instructions = requireNonEmptyString(question.instructions, `questions[${index}].instructions`)
    const topK = optionalPositiveInteger(question.top_k, `questions[${index}].top_k`, 100) ?? 10

    if (type === 'noul') {
      const criteria = parseNoulCriteria(question.criteria, `questions[${index}].criteria`)
      return {
        id,
        type,
        instructions,
        criteria,
        topK,
        minScore: optionalScore(question.min_score, `questions[${index}].min_score`, 1),
      }
    }

    const criteria = parseScoreCriteria(question.criteria, `questions[${index}].criteria`)
    return {
      id,
      type,
      instructions,
      criteria,
      topK,
      minScore: optionalScore(question.min_score, `questions[${index}].min_score`, criteria.length - 1),
    }
  })

  return { keywords, candidateLimit, questions }
}

function parseFindNotionSectionsArguments(raw: unknown): FindNotionSectionsArguments {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Arguments must be an object.')
  }
  const params = raw as Record<string, unknown>
  if (!Array.isArray(params.page_ids) || params.page_ids.length === 0 || params.page_ids.length > 100) {
    throw new Error('page_ids must contain between 1 and 100 page IDs.')
  }

  const seenPageIds = new Set<string>()
  const pageIds = params.page_ids.map((value, index) => {
    const pageId = requireNonEmptyString(value, `page_ids[${index}]`)
    if (seenPageIds.has(pageId)) throw new Error(`page_ids contains duplicate page ID: ${pageId}.`)
    seenPageIds.add(pageId)
    return pageId
  })

  return {
    pageIds,
    question: requireNonEmptyString(params.question, 'question'),
    topK: optionalPositiveInteger(params.top_k, 'top_k', 20) ?? 3,
  }
}

function parsePageIdArguments(raw: unknown): { pageId: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Arguments must be an object.')
  }
  return { pageId: requireNonEmptyString((raw as Record<string, unknown>).page_id, 'page_id') }
}

function parseGetNotionSectionContentArguments(raw: unknown): GetNotionSectionContentArguments {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Arguments must be an object.')
  }
  const params = raw as Record<string, unknown>
  if (!Object.hasOwn(params, 'heading_id')) {
    throw new Error('heading_id must be a Heading block ID or null.')
  }
  return {
    pageId: requireNonEmptyString(params.page_id, 'page_id'),
    headingId: params.heading_id === null
      ? null
      : requireNonEmptyString(params.heading_id, 'heading_id'),
  }
}

function buildSectionCandidates(nodes: NotionBlockNode[]): SectionCandidate[] {
  const root: SectionCandidate = { heading_id: null, heading_path: [], content: '' }
  const sections: SectionCandidate[] = []
  const sectionByHeadingId = new Map<string, SectionCandidate>()
  let headings: HeadingContext[] = []

  for (const { node } of flattenNotionBlockTree(nodes)) {
    const level = getHeadingLevel(node.type)
    if (level !== undefined) {
      while (headings.length > 0 && headings[headings.length - 1]!.level >= level) headings.pop()
      const heading: HeadingContext = {
        id: node.id,
        level,
        text: node.content || `Heading ${level}`,
      }
      headings.push(heading)
      const section: SectionCandidate = {
        heading_id: heading.id,
        heading_path: headings.map(item => item.text),
        content: '',
      }
      sections.push(section)
      sectionByHeadingId.set(heading.id, section)
      continue
    }

    if (!node.content) continue
    const section = headings.length > 0
      ? sectionByHeadingId.get(headings[headings.length - 1]!.id)!
      : root
    section.content = section.content
      ? `${section.content}\n${node.content}`
      : node.content
  }

  return root.content ? [root, ...sections] : sections
}

function collectNotionHeadings(nodes: NotionBlockNode[]): NotionHeading[] {
  const result: NotionHeading[] = []

  const visit = (siblings: NotionBlockNode[], inheritedHeadings: HeadingContext[]) => {
    let headings = [...inheritedHeadings]
    for (const node of siblings) {
      const level = getHeadingLevel(node.type)
      if (level !== undefined) {
        const parentHeadings = headings.slice(0, level - 1).filter(Boolean)
        const heading: HeadingContext = {
          id: node.id,
          level,
          text: node.content || `Heading ${level}`,
        }
        headings = [...parentHeadings, heading]
        result.push({
          block_id: heading.id,
          level: heading.level,
          text: heading.text,
          parent_heading_id: parentHeadings.length > 0 ? parentHeadings[parentHeadings.length - 1]!.id : null,
          heading_path: headings.map(item => item.text),
        })
      }
      visit(node.children, headings)
    }
  }

  visit(nodes, [])
  return result
}

function renderNotionSection(nodes: NotionBlockNode[], headingId: string | null): string {
  const blocks = flattenNotionBlockTree(nodes)
  let start = 0
  let end = blocks.length

  if (headingId === null) {
    const firstHeading = blocks.findIndex(({ node }) => getHeadingLevel(node.type) !== undefined)
    if (firstHeading !== -1) end = firstHeading
  } else {
    const startIndex = blocks.findIndex(({ node }) => node.id === headingId && getHeadingLevel(node.type) !== undefined)
    if (startIndex === -1) {
      throw new Error(`heading_id ${headingId} is not a Heading block in page_id.`)
    }
    start = startIndex
    const level = getHeadingLevel(blocks[start]!.node.type)!
    for (let index = start + 1; index < blocks.length; index++) {
      const nextLevel = getHeadingLevel(blocks[index]!.node.type)
      if (nextLevel !== undefined && nextLevel <= level) {
        end = index
        break
      }
    }
  }

  return blocks
    .slice(start, end)
    .map(renderNotionBlockMarkdown)
    .filter(Boolean)
    .join('\n\n')
}

function flattenNotionBlockTree(
  nodes: NotionBlockNode[],
  depth = 0,
): Array<{ node: NotionBlockNode; depth: number }> {
  return nodes.flatMap(node => [
    { node, depth },
    ...flattenNotionBlockTree(node.children, depth + 1),
  ])
}

function renderNotionBlockMarkdown({ node, depth }: { node: NotionBlockNode; depth: number }): string {
  const content = node.content.trim()
  const indent = '  '.repeat(depth)
  const headingLevel = getHeadingLevel(node.type)
  if (headingLevel !== undefined) return content ? `${'#'.repeat(headingLevel)} ${content}` : ''
  if (!content) return ''

  switch (node.type) {
    case 'bulleted_list_item':
      return `${indent}- ${content}`
    case 'numbered_list_item':
      return `${indent}1. ${content}`
    case 'to_do': {
      const payload = node.raw.to_do
      const checked = !!(payload && typeof payload === 'object' && !Array.isArray(payload)
        && (payload as Record<string, unknown>).checked === true)
      return `${indent}- [${checked ? 'x' : ' '}] ${content}`
    }
    case 'quote':
      return `${indent}> ${content}`
    case 'code': {
      const payload = node.raw.code
      const language = payload && typeof payload === 'object' && !Array.isArray(payload)
        && typeof (payload as Record<string, unknown>).language === 'string'
        ? (payload as Record<string, unknown>).language
        : ''
      return `\`\`\`${language}\n${content}\n\`\`\``
    }
    case 'divider':
      return '---'
    case 'table_row':
      return `| ${content.split(' | ').join(' | ')} |`
    default:
      return `${indent}${content}`
  }
}

function parseNotionSearchResponse(raw: unknown): Array<{ id: string; title?: string; url?: string }> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Notion returned an invalid search response.')
  }
  const results = (raw as Record<string, unknown>).results
  if (!Array.isArray(results)) {
    throw new Error('Notion search response did not include results.')
  }

  return results.flatMap(result => {
    if (!result || typeof result !== 'object' || Array.isArray(result)) return []
    const page = result as Record<string, unknown>
    if (page.object !== 'page' || typeof page.id !== 'string') return []
    return [{
      id: page.id,
      title: extractNotionPageTitle(page),
      url: typeof page.url === 'string' ? page.url : undefined,
    }]
  })
}

/**
 * Keep each Notion page only once before its Markdown is retrieved. A page
 * found through more distinct keywords is retained ahead of single-keyword
 * candidates; equal match counts preserve the original search order.
 */
function prioritizeSearchCandidates(
  candidatesByKeyword: Array<Array<{ id: string; title?: string; url?: string }>>,
  candidateLimit: number,
): Array<{ id: string; title?: string; url?: string }> {
  const candidates = new Map<string, {
    candidate: { id: string; title?: string; url?: string }
    keywordMatches: number
    firstSeen: number
  }>()
  let firstSeen = 0

  for (const keywordCandidates of candidatesByKeyword) {
    const pageIdsInThisKeyword = new Set<string>()
    for (const candidate of keywordCandidates) {
      if (pageIdsInThisKeyword.has(candidate.id)) continue
      pageIdsInThisKeyword.add(candidate.id)

      const existing = candidates.get(candidate.id)
      if (existing) {
        existing.keywordMatches += 1
        existing.candidate.title ??= candidate.title
        existing.candidate.url ??= candidate.url
        continue
      }
      candidates.set(candidate.id, {
        candidate: { ...candidate },
        keywordMatches: 1,
        firstSeen: firstSeen++,
      })
    }
  }

  return [...candidates.values()]
    .sort((left, right) => right.keywordMatches - left.keywordMatches || left.firstSeen - right.firstSeen)
    .slice(0, candidateLimit)
    .map(({ candidate }) => candidate)
}

function extractNotionPageTitle(page: Record<string, unknown>): string | undefined {
  const properties = page.properties
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return undefined

  for (const property of Object.values(properties as Record<string, unknown>)) {
    if (!property || typeof property !== 'object' || Array.isArray(property)) continue
    const titleProperty = property as Record<string, unknown>
    if (titleProperty.type !== 'title' || !Array.isArray(titleProperty.title)) continue
    const title = titleProperty.title
      .map(fragment => {
        if (!fragment || typeof fragment !== 'object' || Array.isArray(fragment)) return ''
        const plainText = (fragment as Record<string, unknown>).plain_text
        return typeof plainText === 'string' ? plainText : ''
      })
      .join('')
    return title || undefined
  }
  return undefined
}

function emptyQuestionResultLists(questions: RankingQuestion[]): Record<string, []> {
  return Object.fromEntries(questions.map(question => [question.id, []]))
}

function parseNotionMarkdownResponse(raw: unknown): { markdown: string; truncated: boolean } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Notion returned an invalid page Markdown response.')
  }
  const page = raw as Record<string, unknown>
  if (typeof page.markdown !== 'string') {
    throw new Error('Notion page Markdown response did not include markdown.')
  }
  return { markdown: page.markdown, truncated: page.truncated === true }
}

function parseNotionBlockChildrenResponse(raw: unknown): {
  blocks: Array<Record<string, unknown>>
  hasMore: boolean
  nextCursor?: string
} {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Notion returned an invalid block-children response.')
  }
  const response = raw as Record<string, unknown>
  if (!Array.isArray(response.results)) {
    throw new Error('Notion block-children response did not include results.')
  }
  return {
    blocks: response.results.filter(
      (block): block is Record<string, unknown> => !!block && typeof block === 'object' && !Array.isArray(block),
    ),
    hasMore: response.has_more === true,
    nextCursor: typeof response.next_cursor === 'string' ? response.next_cursor : undefined,
  }
}

function getHeadingLevel(blockType: string): number | undefined {
  if (blockType === 'heading_1') return 1
  if (blockType === 'heading_2') return 2
  if (blockType === 'heading_3') return 3
  return undefined
}

function isChildDocumentBlock(blockType: string): boolean {
  return blockType === 'child_page' || blockType === 'child_database'
}

function extractNotionBlockText(block: Record<string, unknown>, type: string): string {
  const payload = block[type]
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return ''
  const data = payload as Record<string, unknown>

  if (typeof data.title === 'string') return data.title
  const richText = richTextToPlainText(data.rich_text)
  if (richText) return richText
  const titleText = richTextToPlainText(data.title)
  if (titleText) return titleText

  if (Array.isArray(data.cells)) {
    return data.cells
      .map(cell => richTextToPlainText(cell))
      .filter(Boolean)
      .join(' | ')
  }
  return ''
}

function richTextToPlainText(value: unknown): string {
  if (!Array.isArray(value)) return ''
  return value
    .map(fragment => {
      if (!fragment || typeof fragment !== 'object' || Array.isArray(fragment)) return ''
      const plainText = (fragment as Record<string, unknown>).plain_text
      return typeof plainText === 'string' ? plainText : ''
    })
    .join('')
}

function requireNonEmptyString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string.`)
  }
  return value.trim()
}

function requireQuestionType(value: unknown, name: string): 'noul' | 'score' {
  if (value !== 'noul' && value !== 'score') {
    throw new Error(`${name} must be either "noul" or "score".`)
  }
  return value
}

function parseNoulCriteria(value: unknown, name: string): { true: string; false: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} must be an object with true and false descriptions.`)
  }
  const criteria = value as Record<string, unknown>
  return {
    true: requireNonEmptyString(criteria.true, `${name}.true`),
    false: requireNonEmptyString(criteria.false, `${name}.false`),
  }
}

function parseScoreCriteria(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.length < 2 || value.length > 10) {
    throw new Error(`${name} must contain 2 to 10 ordered score descriptions.`)
  }
  return value.map((criterion, index) => requireNonEmptyString(criterion, `${name}[${index}]`))
}

function optionalScore(value: unknown, name: string, maximum: number): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > maximum) {
    throw new Error(`${name} must be a number from 0 to ${maximum}.`)
  }
  return value
}

function optionalPositiveInteger(value: unknown, name: string, maximum: number): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    throw new Error(`${name} must be an integer from 1 to ${maximum}.`)
  }
  return value as number
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length)
  let nextIndex = 0

  async function worker() {
    while (true) {
      const index = nextIndex++
      if (index >= values.length) return
      results[index] = await mapper(values[index]!)
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker))
  return results
}
