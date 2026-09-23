import { describe, expect, it, vi } from 'vitest'
import { JevClient } from '../client'
import { JevSectionLocator } from '../section-locator'

describe('JevSectionLocator', () => {
  it('maps page-local Choice options to heading IDs without exposing section text', async () => {
    const client = {
      systemOne: vi.fn().mockResolvedValue({
        model: 'jev-1.13.0',
        answers: {
          page_0: {
            type: 'choice',
            choice: 'section_1',
            probabilities: { section_0: 0.12, section_1: 0.87 },
            confidence: 0.84,
          },
          page_1: {
            type: 'choice',
            choice: 'section_0',
            probabilities: { section_0: 1 },
            confidence: 0.87,
          },
        },
        usage: { input_tokens: 200, output_tokens: 30 },
      }),
    } as unknown as JevClient
    const locator = new JevSectionLocator(client)

    const results = await locator.locate('Who approves releases?', [
      {
        page_id: 'page-1',
        sections: [
          { heading_id: 'heading-1', heading_path: ['Release'], content: 'Release weekly.' },
          { heading_id: 'heading-2', heading_path: ['Release', 'Approval'], content: 'The operator must approve.' },
        ],
      },
      {
        page_id: 'page-2',
        sections: [
          { heading_id: null, heading_path: [], content: 'Submit leave requests to HR.' },
        ],
      },
    ], 2)

    expect(results).toEqual({
      'page-1': [
        {
          heading_id: 'heading-2',
          heading_path: ['Release', 'Approval'],
          score: 0.87,
          confidence: 0.84,
        },
        {
          heading_id: 'heading-1',
          heading_path: ['Release'],
          score: 0.12,
          confidence: 0.84,
        },
      ],
      'page-2': [
        {
          heading_id: null,
          heading_path: [],
          score: 1,
          confidence: 0.87,
        },
      ],
    })
    expect(client.systemOne).toHaveBeenCalledTimes(1)
    const [, questions] = vi.mocked(client.systemOne).mock.calls[0]!
    expect(Object.keys(questions)).toEqual(['page_0', 'page_1'])
    expect(questions.page_0).toMatchObject({ type: 'choice' })
    expect(questions.page_0.criteria).toHaveProperty('section_0')
    expect(questions.page_0.criteria).not.toHaveProperty('not_found')
  })
})
