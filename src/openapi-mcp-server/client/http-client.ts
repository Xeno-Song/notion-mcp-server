import type { OpenAPIV3, OpenAPIV3_1 } from 'openapi-types'
import OpenAPIClientAxios from 'openapi-client-axios'
import type { AxiosInstance } from 'axios'
import FormData from 'form-data'
import fs from 'fs'
import { Headers } from './polyfill-headers'
import { isFileUploadParameter } from '../openapi/file-upload'

export type HttpClientConfig = {
  baseUrl: string
  headers?: Record<string, string>
}

export type HttpClientResponse<T = any> = {
  data: T
  status: number
  headers: Headers
}

const NOTION_REQUEST_INTERVAL_MS = 500
const NOTION_MAX_RETRIES = 5
const NOTION_MAX_BACKOFF_MS = 30_000
const NOTION_RETRY_JITTER_MS = 250

/**
 * One MCP process can issue many independent Notion requests concurrently.
 * Serialize their start times and share a cooldown after rate limiting so a
 * retry from one tool does not cause another tool to immediately hit 429.
 */
class NotionRequestScheduler {
  private queue = Promise.resolve()
  private nextStartAt = 0
  private pausedUntil = 0

  async waitForSlot(): Promise<void> {
    let release!: () => void
    const previous = this.queue
    this.queue = new Promise<void>(resolve => { release = resolve })
    await previous

    try {
      const now = Date.now()
      const startAt = Math.max(now, this.nextStartAt, this.pausedUntil)
      await sleep(startAt - now)
      this.nextStartAt = Date.now() + NOTION_REQUEST_INTERVAL_MS
    } finally {
      release()
    }
  }

  pauseFor(delayMs: number): void {
    this.pausedUntil = Math.max(this.pausedUntil, Date.now() + delayMs)
  }
}

const notionRequestScheduler = new NotionRequestScheduler()

export class HttpClientError extends Error {
  constructor(
    message: string,
    public status: number,
    public data: any,
    public headers?: Headers,
  ) {
    super(`${status} ${message}`)
    this.name = 'HttpClientError'
  }
}

export class HttpClient {
  private api: Promise<AxiosInstance>
  private client: OpenAPIClientAxios
  private config: HttpClientConfig
  private openApiSpec: OpenAPIV3.Document | OpenAPIV3_1.Document
  private usesNotionApi: boolean

  constructor(config: HttpClientConfig, openApiSpec: OpenAPIV3.Document | OpenAPIV3_1.Document) {
    this.config = config
    this.openApiSpec = openApiSpec
    this.usesNotionApi = isNotionApiBaseUrl(config.baseUrl)
    // @ts-expect-error
    this.client = new (OpenAPIClientAxios.default ?? OpenAPIClientAxios)({
      definition: openApiSpec,
      axiosConfigDefaults: {
        baseURL: config.baseUrl,
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'notion-mcp-server',
          ...config.headers,
        },
      },
    })
    this.api = this.client.init()
  }

  /**
   * Resolve a possibly-$ref'd parameter to its inline definition.
   * Only local refs (e.g. `#/components/parameters/notionVersion`) are supported.
   */
  private resolveParameter(
    param: OpenAPIV3.ParameterObject | OpenAPIV3.ReferenceObject,
  ): OpenAPIV3.ParameterObject | null {
    if (!('$ref' in param)) {
      return param as OpenAPIV3.ParameterObject
    }
    const ref = param.$ref
    if (!ref.startsWith('#/')) {
      return null
    }
    let node: any = this.openApiSpec
    for (const segment of ref.slice(2).split('/')) {
      node = node?.[segment]
      if (node === undefined) return null
    }
    return node && node.name ? (node as OpenAPIV3.ParameterObject) : null
  }

  /**
   * Build the server-managed header parameters declared on an operation.
   *
   * Header parameters (currently `Notion-Version`) are not exposed as tool
   * inputs; their value comes from the operation's header-parameter `default`
   * in the OpenAPI spec. This lets each endpoint pin the API version it needs —
   * e.g. the page-markdown endpoints require `2026-03-11` while the rest of the
   * API stays on `2025-09-03`. A header the caller configured globally (via
   * HttpClientConfig.headers) takes precedence and is left untouched.
   */
  private buildDefaultHeaders(operation: OpenAPIV3.OperationObject): Record<string, string> {
    const configured = new Set(Object.keys(this.config.headers ?? {}).map((key) => key.toLowerCase()))
    const headers: Record<string, string> = {}
    for (const param of operation.parameters ?? []) {
      const resolved = this.resolveParameter(param)
      if (!resolved || resolved.in !== 'header' || configured.has(resolved.name.toLowerCase())) {
        continue
      }
      const schema = resolved.schema as OpenAPIV3.SchemaObject | undefined
      if (schema && schema.default !== undefined) {
        headers[resolved.name] = String(schema.default)
      }
    }
    return headers
  }

  private async prepareFileUpload(operation: OpenAPIV3.OperationObject, params: Record<string, any>): Promise<FormData | null> {
    const fileParams = isFileUploadParameter(operation)
    if (fileParams.length === 0) return null

    const formData = new FormData()

    // Handle file uploads
    for (const param of fileParams) {
      const fileSource = params[param]
      if (!fileSource) {
        throw new Error(`File path must be provided for parameter: ${param}`)
      }
      switch (typeof fileSource) {
        case 'string':
          addFile(param, fileSource)
          break
        case 'object':
          if (Array.isArray(fileSource)) {
            for (const file of fileSource) {
              addFile(param, file)
            }
            break
          }
          if (typeof fileSource.path === 'string' && Number.isSafeInteger(fileSource.start) && Number.isSafeInteger(fileSource.end) && fileSource.start >= 0 && fileSource.end >= fileSource.start) {
            const stream = fs.createReadStream(fileSource.path, { start: fileSource.start, end: fileSource.end })
            formData.append(param, stream, {
              filename: fileSource.filename,
              knownLength: fileSource.end - fileSource.start + 1,
            })
            break
          }
          //deliberate fallthrough
        default:
          throw new Error(`Unsupported file type: ${typeof fileSource}`)
      }
      function addFile(name: string, filePath: string) {
          try {
            const fileStream = fs.createReadStream(filePath)
            formData.append(name, fileStream)
        } catch (error) {
          throw new Error(`Failed to read file at ${filePath}: ${error}`)
        }
      }
    }

    // Path/query parameters belong in the URL, not in the multipart body.
    const urlParameters = new Set((operation.parameters ?? [])
      .filter(param => 'name' in param && (param.in === 'path' || param.in === 'query'))
      .map(param => (param as OpenAPIV3.ParameterObject).name))
    for (const [key, value] of Object.entries(params)) {
      if (!fileParams.includes(key) && !urlParameters.has(key) && value !== undefined) {
        formData.append(key, String(value))
      }
    }

    return formData
  }

  /**
   * Execute an OpenAPI operation
   */
  async executeOperation<T = any>(
    operation: OpenAPIV3.OperationObject & { method: string; path: string },
    params: Record<string, any> = {},
  ): Promise<HttpClientResponse<T>> {
    const api = await this.api
    const operationId = operation.operationId
    if (!operationId) {
      throw new Error('Operation ID is required')
    }

    const operationFn = (api as any)[operationId]
    if (!operationFn) {
      throw new Error(`Operation ${operationId} not found`)
    }

    for (let attempt = 0; ; attempt++) {
      if (this.usesNotionApi) await notionRequestScheduler.waitForSlot()

      try {
        return await this.executeOperationAttempt<T>(operation, params, operationFn)
      } catch (error) {
        const retryDelay = this.usesNotionApi ? getNotionRetryDelay(error, attempt) : undefined
        if (retryDelay === undefined || attempt >= NOTION_MAX_RETRIES) {
          throwHttpClientError(error)
        }

        notionRequestScheduler.pauseFor(retryDelay)
        if (process.env.NODE_ENV !== 'test') {
          console.warn('Retrying Notion request after rate limiting', {
            operationId,
            attempt: attempt + 1,
            retryDelayMs: retryDelay,
          })
        }
      }
    }
  }

  private async executeOperationAttempt<T>(
    operation: OpenAPIV3.OperationObject & { method: string; path: string },
    params: Record<string, any>,
    operationFn: (...args: any[]) => Promise<any>,
  ): Promise<HttpClientResponse<T>> {
    // Create a fresh FormData body for every attempt so file streams are never
    // reused after a failed HTTP request.
    const formData = await this.prepareFileUpload(operation, params)
    const urlParameters: Record<string, any> = {}
    const bodyParams: Record<string, any> = formData || { ...params }

    if (operation.parameters) {
      for (const param of operation.parameters) {
        if (!('name' in param) || !param.name || !param.in) continue
        if ((param.in === 'path' || param.in === 'query') && params[param.name] !== undefined) {
          urlParameters[param.name] = params[param.name]
          if (!formData) delete bodyParams[param.name]
        }
      }
    }

    if (!operation.requestBody && !formData) {
      for (const key in bodyParams) {
        if (bodyParams[key] !== undefined) {
          urlParameters[key] = bodyParams[key]
          delete bodyParams[key]
        }
      }
    }

    const hasBody = Object.keys(bodyParams).length > 0
    const headers = formData
      ? formData.getHeaders()
      : { ...(hasBody ? { 'Content-Type': 'application/json' } : { 'Content-Type': null }) }
    const requestConfig = {
      headers: {
        ...this.buildDefaultHeaders(operation),
        ...headers,
      },
    }
    const response = await operationFn(urlParameters, hasBody ? bodyParams : undefined, requestConfig)
    const responseHeaders = new Headers()
    Object.entries(response.headers ?? {}).forEach(([key, value]) => {
      if (value) responseHeaders.append(key, value.toString())
    })
    return { data: response.data, status: response.status, headers: responseHeaders }
  }
}

function isNotionApiBaseUrl(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname === 'api.notion.com'
  } catch {
    return false
  }
}

function getNotionRetryDelay(error: unknown, attempt: number): number | undefined {
  const response = getErrorResponse(error)
  if (!response || (response.status !== 429 && response.status !== 529)) return undefined

  const retryAfterMs = retryAfterMilliseconds(response.headers, response.data)
  const exponentialBackoffMs = Math.min(1_000 * 2 ** attempt, NOTION_MAX_BACKOFF_MS)
  const baseDelayMs = retryAfterMs === undefined
    ? exponentialBackoffMs
    : attempt === 0 ? retryAfterMs : Math.max(retryAfterMs, exponentialBackoffMs)
  const jitterMs = process.env.NODE_ENV === 'test' ? 0 : Math.floor(Math.random() * NOTION_RETRY_JITTER_MS)
  return baseDelayMs + jitterMs
}

function retryAfterMilliseconds(headers: unknown, data: unknown): number | undefined {
  const headerValue = readHeader(headers, 'retry-after')
  const headerSeconds = parseNonNegativeSeconds(headerValue)
  if (headerSeconds !== undefined) return headerSeconds * 1_000

  if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined
  const body = data as Record<string, unknown>
  const additionalData = body.additional_data
  if (additionalData && typeof additionalData === 'object' && !Array.isArray(additionalData)) {
    const seconds = parseNonNegativeSeconds((additionalData as Record<string, unknown>).retry_after)
    if (seconds !== undefined) return seconds * 1_000
  }
  return parseNonNegativeSeconds(body.retryAfter) === undefined
    ? undefined
    : parseNonNegativeSeconds(body.retryAfter)! * 1_000
}

function readHeader(headers: unknown, name: string): unknown {
  if (!headers || typeof headers !== 'object') return undefined
  const candidate = headers as { get?: (name: string) => unknown } & Record<string, unknown>
  if (typeof candidate.get === 'function') return candidate.get(name)
  return candidate[name] ?? candidate[name.toLowerCase()]
}

function parseNonNegativeSeconds(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
}

function getErrorResponse(error: unknown): {
  status?: number
  statusText?: string
  data?: unknown
  headers?: unknown
} | undefined {
  if (!error || typeof error !== 'object' || !('response' in error)) return undefined
  const response = (error as { response?: unknown }).response
  return response && typeof response === 'object'
    ? response as { status?: number; statusText?: string; data?: unknown; headers?: unknown }
    : undefined
}

function throwHttpClientError(error: unknown): never {
  const response = getErrorResponse(error)
  if (!response) throw error

  if (process.env.NODE_ENV !== 'test') {
    console.error('Error in http client', {
      status: response.status,
      statusText: response.statusText,
    })
  }
  const headers = new Headers()
  if (response.headers && typeof response.headers === 'object') {
    Object.entries(response.headers).forEach(([key, value]) => {
      if (value) headers.append(key, String(value))
    })
  }
  throw new HttpClientError(
    response.statusText || 'Request failed',
    response.status ?? 0,
    response.data,
    headers,
  )
}

function sleep(delayMs: number): Promise<void> {
  return delayMs > 0
    ? new Promise(resolve => setTimeout(resolve, delayMs))
    : Promise.resolve()
}
