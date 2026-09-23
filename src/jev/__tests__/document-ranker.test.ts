import { describe, expect, it, vi } from 'vitest'
import { JevClient, JevClientError, JevSystemOneResponse } from '../client'
import { JevDocumentRanker, RankingQuestion } from '../document-ranker'

const questions: RankingQuestion[] = [
  {
    id: 'contains_approval',
    type: 'noul',
    instructions: 'Does this document explain approval?',
    criteria: { true: 'Directly explains approval', false: 'Does not explain approval' },
    topK: 10,
    minScore: 0.6,
  },
  {
    id: 'answer_completeness',
    type: 'score',
    instructions: 'How completely does this document answer the approval question?',
    criteria: ['Unrelated', 'Mention only', 'Partial answer', 'Direct answer'],
    topK: 1,
    minScore: 2,
  },
]

function response(answers: JevSystemOneResponse['answers'], inputTokens = 100): JevSystemOneResponse {
  return {
    model: 'jev-1.13.0',
    answers,
    usage: { input_tokens: inputTokens, output_tokens: 7 },
  }
}

function scoreAnswer(score: number, confidence: number) {
  return {
    type: 'score' as const,
    score,
    confidence,
    legend: { '0': 'Unrelated', '1': 'Mention only', '2': 'Partial answer', '3': 'Direct answer' },
    probabilities: { '0': 0, '1': 0, '2': 0.2, '3': 0.8 },
  }
}

describe('JevDocumentRanker', () => {
  it('applies every question to every document and returns independent question-keyed lists', async () => {
    const client = {
      getModel: vi.fn(() => 'jev-latest'),
      systemOne: vi.fn().mockResolvedValue(response({
        document_0_question_0: { type: 'noul', noul: 0.21 },
        document_0_question_1: scoreAnswer(1.4, 0.75),
        document_1_question_0: { type: 'noul', noul: 0.93 },
        document_1_question_1: scoreAnswer(2.8, 0.88),
      })),
    } as unknown as JevClient
    const ranker = new JevDocumentRanker(client, { maxStateCharacters: 10_000 })

    const ranking = await ranker.rank(questions, [
      { id: 'page-a', title: '휴가 정책', markdown: '# 휴가' },
      { id: 'page-b', title: '운영 배포', url: 'https://notion.so/page-b', markdown: '# 승인 절차' },
    ])

    expect(ranking.results).toEqual({
      contains_approval: [
        { page_id: 'page-b', title: '운영 배포', url: 'https://notion.so/page-b', score: 0.93 },
      ],
      answer_completeness: [
        { page_id: 'page-b', title: '운영 배포', url: 'https://notion.so/page-b', score: 2.8, confidence: 0.88 },
      ],
    })
    expect(ranking.usage).toEqual({ inputTokens: 100, outputTokens: 7, requests: 1 })
    expect(client.systemOne).toHaveBeenCalledTimes(1)

    const [, jevQuestions] = vi.mocked(client.systemOne).mock.calls[0]!
    expect(Object.keys(jevQuestions)).toEqual([
      'document_0_question_0',
      'document_0_question_1',
      'document_1_question_0',
      'document_1_question_1',
    ])
  })

  it('batches candidates below the configured context guard and keeps each list sorted by raw score', async () => {
    const oneQuestion = [questions[0]!]
    const client = {
      getModel: vi.fn(() => 'jev-latest'),
      systemOne: vi.fn()
        .mockResolvedValueOnce(response({ document_0_question_0: { type: 'noul', noul: 0.7 } }, 10))
        .mockResolvedValueOnce(response({ document_0_question_0: { type: 'noul', noul: 0.9 } }, 12)),
    } as unknown as JevClient
    const ranker = new JevDocumentRanker(client, { maxStateCharacters: 600 })

    const ranking = await ranker.rank(oneQuestion, [
      { id: 'first', markdown: 'a'.repeat(250) },
      { id: 'second', markdown: 'b'.repeat(250) },
    ])

    expect(client.systemOne).toHaveBeenCalledTimes(2)
    expect(ranking.results.contains_approval?.map(result => result.page_id)).toEqual(['second', 'first'])
    expect(ranking.usage).toEqual({ inputTokens: 22, outputTokens: 14, requests: 2 })
  })

  it('does not silently score Notion-truncated pages or pages rejected by Jev context capacity', async () => {
    const oneQuestion = [questions[0]!]
    const client = {
      getModel: vi.fn(() => 'jev-latest'),
      systemOne: vi.fn()
        .mockRejectedValueOnce(new JevClientError('Jev request failed with HTTP 422.', 422))
        .mockResolvedValueOnce(response({ document_0_question_0: { type: 'noul', noul: 0.7 } })),
    } as unknown as JevClient
    const ranker = new JevDocumentRanker(client, { maxStateCharacters: 600 })

    const ranking = await ranker.rank(oneQuestion, [
      { id: 'truncated', markdown: 'content', notionMarkdownTruncated: true },
      { id: 'too-large', markdown: 'a'.repeat(400) },
      { id: 'usable', markdown: 'okay' },
    ])

    expect(ranking.results.contains_approval?.map(result => result.page_id)).toEqual(['usable'])
    expect(ranking.skipped).toEqual([
      { id: 'truncated', title: undefined, reason: 'notion_content_truncated' },
      { id: 'too-large', title: undefined, reason: 'jev_context_limit' },
    ])
  })
})
