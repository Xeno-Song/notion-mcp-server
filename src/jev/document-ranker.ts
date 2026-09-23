import { JevClient, JevClientError, JevNoulQuestion, JevScoreQuestion } from './client'

export type RankableDocument = {
  id: string
  title?: string
  url?: string
  markdown: string
  notionMarkdownTruncated?: boolean
}

export type NoulRankingQuestion = {
  id: string
  type: 'noul'
  instructions: string
  criteria: NonNullable<JevNoulQuestion['criteria']>
  topK: number
  minScore?: number
}

export type ScoreRankingQuestion = {
  id: string
  type: 'score'
  instructions: string
  criteria: string[]
  topK: number
  minScore?: number
}

export type RankingQuestion = NoulRankingQuestion | ScoreRankingQuestion

export type RankedDocument = {
  page_id: string
  title?: string
  url?: string
  /** Raw Jev Noul probability (0–1) or Score value (0–criteria.length - 1). */
  score: number
  /** Score answers have calibrated confidence; Noul answers do not. */
  confidence?: number
}

export type SkippedDocument = {
  id: string
  title?: string
  reason: 'notion_content_truncated' | 'jev_context_limit'
}

export type DocumentRankingResult = {
  model: string
  results: Record<string, RankedDocument[]>
  skipped: SkippedDocument[]
  usage: {
    inputTokens: number
    outputTokens: number
    requests: number
  }
}

export type DocumentRankerOptions = {
  /**
   * Conservative character guard for Jev's 32k-token state allowance. This is
   * configurable because character-to-token ratios differ across languages.
   */
  maxStateCharacters?: number
}

const DEFAULT_MAX_STATE_CHARACTERS = 30_000

/**
 * Applies every independent Jev question to every candidate document. The
 * returned object is keyed by question ID so each question can keep its own
 * raw scoring scale, threshold, and result limit.
 */
export class JevDocumentRanker {
  private readonly maxStateCharacters: number

  constructor(
    private readonly client: JevClient,
    options: DocumentRankerOptions = {},
  ) {
    this.maxStateCharacters = options.maxStateCharacters ?? DEFAULT_MAX_STATE_CHARACTERS
  }

  async rank(
    questions: RankingQuestion[],
    documents: RankableDocument[],
    model?: string,
  ): Promise<DocumentRankingResult> {
    const batches: RankableDocument[][] = []
    const skipped: SkippedDocument[] = []
    let batch: RankableDocument[] = []
    let batchCharacters = 0

    for (const document of documents) {
      if (document.notionMarkdownTruncated) {
        skipped.push({ id: document.id, title: document.title, reason: 'notion_content_truncated' })
        continue
      }

      const documentCharacters = estimateDocumentCharacters(document)
      // Do not pre-truncate a large page. It is sent on its own, and reported
      // as too large only if Jev rejects the actual request.
      if (documentCharacters > this.maxStateCharacters) {
        if (batch.length > 0) batches.push(batch)
        batch = []
        batchCharacters = 0
        batches.push([document])
        continue
      }

      if (batch.length > 0 && batchCharacters + documentCharacters > this.maxStateCharacters) {
        batches.push(batch)
        batch = []
        batchCharacters = 0
      }

      batch.push(document)
      batchCharacters += documentCharacters
    }

    if (batch.length > 0) batches.push(batch)

    const unfilteredResults = Object.fromEntries(questions.map(question => [question.id, [] as RankedDocument[]]))
    let inputTokens = 0
    let outputTokens = 0
    let resolvedModel = this.client.getModel(model)

    for (const documentBatch of batches) {
      const state = {
        documents: documentBatch.map(document => ({
          title: document.title ?? '',
          content: document.markdown,
        })),
      }
      const jevQuestions = Object.fromEntries(
        documentBatch.flatMap((_, documentIndex) =>
          questions.map((question, questionIndex) => [
            questionKey(documentIndex, questionIndex),
            buildDocumentQuestion(question, documentIndex),
          ]),
        ),
      )

      let response
      try {
        response = await this.client.systemOne(state, jevQuestions, model)
      } catch (error) {
        if (
          error instanceof JevClientError &&
          error.status === 422 &&
          documentBatch.length === 1 &&
          estimateDocumentCharacters(documentBatch[0]!) > this.maxStateCharacters
        ) {
          const document = documentBatch[0]!
          skipped.push({ id: document.id, title: document.title, reason: 'jev_context_limit' })
          continue
        }
        throw error
      }

      resolvedModel = response.model
      inputTokens += response.usage.input_tokens
      outputTokens += response.usage.output_tokens

      documentBatch.forEach((document, documentIndex) => {
        questions.forEach((question, questionIndex) => {
          const answer = response.answers[questionKey(documentIndex, questionIndex)]
          const result = unfilteredResults[question.id]
          if (!result || !answer || answer.type !== question.type) {
            throw new JevClientError(`Jev omitted a ${question.type} score for document ${document.id}.`)
          }

          if (answer.type === 'noul') {
            if (!Number.isFinite(answer.noul)) {
              throw new JevClientError(`Jev returned an invalid Noul score for document ${document.id}.`)
            }
            result.push({ page_id: document.id, title: document.title, url: document.url, score: answer.noul })
            return
          }

          if (!Number.isFinite(answer.score) || !Number.isFinite(answer.confidence)) {
            throw new JevClientError(`Jev returned an invalid Score answer for document ${document.id}.`)
          }
          result.push({
            page_id: document.id,
            title: document.title,
            url: document.url,
            score: answer.score,
            confidence: answer.confidence,
          })
        })
      })
    }

    const results = Object.fromEntries(
      questions.map(question => [
        question.id,
        unfilteredResults[question.id]!
          .filter(result => question.minScore === undefined || result.score >= question.minScore)
          .sort((left, right) => right.score - left.score)
          .slice(0, question.topK),
      ]),
    )

    return {
      model: resolvedModel,
      results,
      skipped,
      usage: { inputTokens, outputTokens, requests: batches.length },
    }
  }
}

function buildDocumentQuestion(question: RankingQuestion, documentIndex: number): JevNoulQuestion | JevScoreQuestion {
  const instructions = {
    question: question.instructions,
    document: `documents[${documentIndex}]`,
    task: 'Apply the question and its criteria only to the referenced document.',
  }
  if (question.type === 'noul') {
    return { type: 'noul', instructions, criteria: question.criteria }
  }
  return { type: 'score', instructions, criteria: question.criteria }
}

function questionKey(documentIndex: number, questionIndex: number): string {
  return `document_${documentIndex}_question_${questionIndex}`
}

function estimateDocumentCharacters(document: RankableDocument): number {
  return document.markdown.length + (document.title?.length ?? 0) + 300
}
