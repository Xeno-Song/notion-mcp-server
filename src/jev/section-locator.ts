import { JevChoiceQuestion, JevClient, JevClientError } from './client'

export type SectionCandidate = {
  /** The section's Heading block ID; null represents the page preamble. */
  heading_id: string | null
  heading_path: string[]
  /**
   * Text belonging directly to this section. Descendant Heading sections are
   * represented by their own candidates, so text is never duplicated across
   * Choice options.
   */
  content: string
}

export type PageSectionCandidates = {
  page_id: string
  sections: SectionCandidate[]
}

export type LocatedSection = Omit<SectionCandidate, 'content'> & {
  /** Choice probability within this page's candidate set. */
  score: number
  confidence: number
}

const MAX_CHOICE_OPTIONS = 255
const MAX_SECTION_OPTIONS = MAX_CHOICE_OPTIONS
const DEFAULT_MAX_REQUEST_CHARACTERS = 30_000

/**
 * Locates relevant logical Heading sections without exposing a page's
 * complete Markdown to the LLM. Jev Choice options are temporary local IDs;
 * their chosen values are mapped back to real Notion Heading IDs before
 * returning.
 */
export class JevSectionLocator {
  constructor(
    private readonly client: JevClient,
    private readonly maxRequestCharacters = DEFAULT_MAX_REQUEST_CHARACTERS,
  ) {}

  async locate(
    question: string,
    pages: PageSectionCandidates[],
    topK: number,
  ): Promise<Record<string, LocatedSection[]>> {
    const results = Object.fromEntries(pages.map(page => [page.page_id, [] as LocatedSection[]]))
    const pagesWithSections = pages
      .map(page => ({ ...page, sections: selectChoiceSections(page.sections) }))
      .filter(page => page.sections.length > 0)

    for (const batch of batchPages(pagesWithSections, this.maxRequestCharacters)) {
      const questions = Object.fromEntries(
        batch.map((page, index) => [
          `page_${index}`,
          buildChoiceQuestion(question, page.sections),
        ]),
      )
      const response = await this.client.systemOne({}, questions)

      batch.forEach((page, index) => {
        const answer = response.answers[`page_${index}`]
        if (!answer || answer.type !== 'choice' || !Number.isFinite(answer.confidence)) {
          throw new JevClientError(`Jev omitted a Choice answer for page ${page.page_id}.`)
        }

        const candidatesByOption = new Map(page.sections.map((section, sectionIndex) => [`section_${sectionIndex}`, section]))
        const pageResults = results[page.page_id]!
        const selected = Object.entries(answer.probabilities)
          .filter(([, probability]) => Number.isFinite(probability))
          .sort(([, left], [, right]) => right - left)
          .slice(0, topK)

        for (const [option, score] of selected) {
          const section = candidatesByOption.get(option)
          if (!section) continue
          pageResults.push({
            heading_id: section.heading_id,
            heading_path: section.heading_path,
            score,
            confidence: answer.confidence,
          })
        }
      })
    }

    return results
  }
}

function buildChoiceQuestion(question: string, sections: SectionCandidate[]): JevChoiceQuestion {
  return {
    type: 'choice',
    instructions: {
      question,
      task: 'Select the Heading section that most directly contains the information needed to answer the question.',
    },
    criteria: Object.fromEntries(sections.map((section, index) => [
        `section_${index}`,
        {
          heading_path: section.heading_path,
          content: section.content,
        },
      ])),
  }
}

function selectChoiceSections(sections: SectionCandidate[]): SectionCandidate[] {
  // Choice can represent at most 255 options. Sections are already the
  // smallest non-overlapping navigable unit, so retain their document order.
  return sections.slice(0, MAX_SECTION_OPTIONS)
}

function batchPages(pages: PageSectionCandidates[], maxCharacters: number): PageSectionCandidates[][] {
  const batches: PageSectionCandidates[][] = []
  let batch: PageSectionCandidates[] = []
  let batchCharacters = 0

  for (const page of pages) {
    const pageCharacters = page.sections.reduce(
      (total, section) => total + section.content.length + section.heading_path.join('/').length + 100,
      0,
    )
    if (batch.length > 0 && batchCharacters + pageCharacters > maxCharacters) {
      batches.push(batch)
      batch = []
      batchCharacters = 0
    }
    batch.push(page)
    batchCharacters += pageCharacters
  }
  if (batch.length > 0) batches.push(batch)
  return batches
}
