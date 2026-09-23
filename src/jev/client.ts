export type JevNoulQuestion = {
  type: 'noul'
  instructions: string | Record<string, unknown> | unknown[]
  criteria?: {
    true: string | Record<string, unknown> | unknown[]
    false: string | Record<string, unknown> | unknown[]
  }
}

export type JevScoreQuestion = {
  type: 'score'
  instructions: string | Record<string, unknown> | unknown[]
  criteria: Array<string | Record<string, unknown> | unknown[]>
}

export type JevChoiceQuestion = {
  type: 'choice'
  instructions: string | Record<string, unknown> | unknown[]
  criteria: Record<string, string | Record<string, unknown> | unknown[] | null>
}

export type JevQuestion = JevNoulQuestion | JevScoreQuestion | JevChoiceQuestion

export type JevSystemOneRequest = {
  state: string | Record<string, unknown> | unknown[]
  model: string
  questions: Record<string, JevQuestion>
}

export type JevNoulAnswer = {
  type: 'noul'
  noul: number
}

export type JevScoreAnswer = {
  type: 'score'
  score: number
  legend: Record<string, string>
  probabilities: Record<string, number>
  confidence: number
}

export type JevChoiceAnswer = {
  type: 'choice'
  choice: string
  probabilities: Record<string, number>
  confidence: number
}

export type JevAnswer = JevNoulAnswer | JevScoreAnswer | JevChoiceAnswer

export type JevSystemOneResponse = {
  model: string
  answers: Record<string, JevAnswer>
  usage: {
    input_tokens: number
    output_tokens: number
  }
}

export class JevClientError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message)
    this.name = 'JevClientError'
  }
}

type JevClientOptions = {
  apiKey?: string
  baseUrl?: string
  defaultModel?: string
  fetchImpl?: typeof fetch
}

/**
 * Minimal client for TypeSafe's Jev System One API.
 *
 * The client deliberately uses fetch rather than an SDK so the MCP server has
 * no additional runtime dependency. `JEV_API_KEY` is supported as a local
 * convenience alias; TypeSafe's documented name is `TYPESAFE_API_KEY`.
 */
export class JevClient {
  private readonly apiKey: string | undefined
  private readonly baseUrl: string
  private readonly defaultModel: string
  private readonly fetchImpl: typeof fetch

  constructor(options: JevClientOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.TYPESAFE_API_KEY ?? process.env.JEV_API_KEY
    this.baseUrl = (options.baseUrl ?? process.env.TYPESAFE_BASE_URL ?? 'https://api.typesafe.ai').replace(/\/$/, '')
    this.defaultModel = options.defaultModel ?? process.env.TYPESAFE_DEFAULT_MODEL ?? 'jev-latest'
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  getModel(model?: string): string {
    return model ?? this.defaultModel
  }

  async systemOne(
    state: JevSystemOneRequest['state'],
    questions: JevSystemOneRequest['questions'],
    model?: string,
  ): Promise<JevSystemOneResponse> {
    if (!this.apiKey) {
      throw new JevClientError('Missing Jev API key. Set TYPESAFE_API_KEY (or JEV_API_KEY).')
    }

    const request: JevSystemOneRequest = {
      state,
      model: this.getModel(model),
      questions,
    }

    let response: Response
    try {
      response = await this.fetchImpl(`${this.baseUrl}/v1/systemone`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(10_000),
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown network error'
      throw new JevClientError(`Jev request failed: ${message}`)
    }

    if (!response.ok) {
      throw new JevClientError(`Jev request failed with HTTP ${response.status}.`, response.status)
    }

    const data = await response.json()
    if (!isJevSystemOneResponse(data)) {
      throw new JevClientError('Jev returned an invalid response.')
    }

    return data
  }
}

function isJevSystemOneResponse(value: unknown): value is JevSystemOneResponse {
  if (!value || typeof value !== 'object') return false
  const response = value as Partial<JevSystemOneResponse>
  return (
    typeof response.model === 'string' &&
    !!response.answers &&
    typeof response.answers === 'object' &&
    !!response.usage &&
    typeof response.usage.input_tokens === 'number' &&
    typeof response.usage.output_tokens === 'number'
  )
}
