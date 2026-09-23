import { describe, expect, it, vi } from 'vitest'
import { JevClient, JevClientError } from '../client'

describe('JevClient', () => {
  it('calls TypeSafe System One with the documented request envelope', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          model: 'jev-1.13.0',
          answers: { relevant: { type: 'noul', noul: 0.86 } },
          usage: { input_tokens: 32, output_tokens: 5 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    )
    const client = new JevClient({ apiKey: 'test-key', fetchImpl })

    const response = await client.systemOne(
      { question: '질문', document: '본문' },
      {
        relevant: {
          type: 'noul',
          instructions: 'Does `document` answer `question`?',
        },
      },
    )

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.typesafe.ai/v1/systemone',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer test-key' }),
      }),
    )
    const request = JSON.parse(fetchImpl.mock.calls[0]![1].body)
    expect(request).toEqual({
      model: 'jev-latest',
      state: { question: '질문', document: '본문' },
      questions: {
        relevant: {
          type: 'noul',
          instructions: 'Does `document` answer `question`?',
        },
      },
    })
    expect(response.answers.relevant).toEqual({ type: 'noul', noul: 0.86 })
  })

  it('fails clearly before a network call when no API key is configured', async () => {
    const fetchImpl = vi.fn()
    const client = new JevClient({ apiKey: '', fetchImpl })

    await expect(client.systemOne('state', {})).rejects.toBeInstanceOf(JevClientError)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
