# Jev semantic search guide

This server adds read-only Notion tools backed by [Jev](https://www.typesafe.ai/).
Jev receives the source content for semantic evaluation, while the MCP client
receives only compact IDs, scores, and the Markdown it explicitly asks to read.

## Prerequisites

The MCP process needs both credentials:

- `NOTION_TOKEN`: a Notion integration token with access to the target pages.
- `TYPESAFE_API_KEY`: a TypeSafe Jev API key. `JEV_API_KEY` also works.

Optional settings:

- `TYPESAFE_BASE_URL`: overrides `https://api.typesafe.ai`.
- `TYPESAFE_DEFAULT_MODEL`: overrides `jev-latest`.

Build the server before connecting it.

```powershell
git clone https://github.com/Xeno-Song/notion-mcp-server.git
cd notion-mcp-server
npm ci
npm run build
```

For Codex, add an MCP server entry to your user configuration. Replace
`C:/path/to/notion-mcp-server` with the absolute path of your checkout.

```toml
[mcp_servers.notion_jev]
command = "node"
args = ["C:/path/to/notion-mcp-server/bin/cli.mjs"]
cwd = "C:/path/to/notion-mcp-server"
env_vars = ["NOTION_TOKEN", "TYPESAFE_API_KEY"]
startup_timeout_sec = 20
tool_timeout_sec = 60
```

Set the environment variables, then restart Codex so it inherits them.

```powershell
setx NOTION_TOKEN "ntn_..."
setx TYPESAFE_API_KEY "..."
```

## Notion request limits

Requests to `api.notion.com` start at most twice per second in this MCP
process. On an HTTP `429` or `529`, the shared request queue pauses for
Notion's `Retry-After` value and retries the failed request. If the header is
absent or the limit repeats, retries use exponential backoff. There are at
most five retries; other HTTP errors are returned without automatic retries.

The queue covers title searches, Markdown retrieval, block traversal, and the
ordinary Notion MCP tools.

## 1. Rank documents

`rank-notion-documents` performs cheap Notion title searches to collect page
candidates, deduplicates them, retrieves each retained page's Markdown once,
and asks Jev every supplied Noul or Score question. It returns no page body to
the LLM.

```json
{
  "keywords": ["release approval", "operator"],
  "candidate_limit": 50,
  "questions": [
    {
      "id": "contains_approval",
      "type": "noul",
      "instructions": "Does this page directly state who approves a release?",
      "criteria": {
        "true": "The approver or approval condition is stated directly.",
        "false": "Approval is absent or mentioned only incidentally."
      },
      "top_k": 10
    },
    {
      "id": "answer_completeness",
      "type": "score",
      "instructions": "How completely does this page answer the release approval question?",
      "criteria": ["No answer", "Mention only", "Partial answer", "Direct answer"],
      "top_k": 5,
      "min_score": 2
    }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `keywords` | One to 20 minimal title-search keywords. Each search returns up to 100 pages. |
| `candidate_limit` | Maximum unique pages retrieved and evaluated. Defaults to 50; maximum is 100. Pages found by more distinct keywords are retained first. |
| `questions` | One to 20 independent Noul or Score questions. |
| `questions[].top_k` | Maximum returned pages for that question. Defaults to 10. |
| `questions[].min_score` | Optional raw-score threshold for that question. |

The result is keyed by question ID. Scores are raw: Noul is `0..1`; Score is
`0..criteria.length - 1`. A Score result also includes Jev's `confidence`.

```json
{
  "contains_approval": [
    {
      "page_id": "notion-page-id",
      "title": "Release guide",
      "url": "https://notion.so/...",
      "score": 0.94
    }
  ],
  "answer_completeness": [
    {
      "page_id": "notion-page-id",
      "title": "Release guide",
      "url": "https://notion.so/...",
      "score": 2.79,
      "confidence": 0.88
    }
  ]
}
```

## 2. Find relevant Heading sections

`find-notion-sections` applies one identical Choice question to each supplied
page. Its candidates are the page preamble and logical Heading sections, not
individual blocks. A section candidate contains its Heading path and only its
direct body blocks. Descendant Heading sections are separate candidates, so
the text sent to Jev is not duplicated across parent and child sections.

```json
{
  "page_ids": ["notion-page-id-1", "notion-page-id-2"],
  "question": "Which section directly states who approves a release?",
  "top_k": 3
}
```

`top_k` defaults to 3 and is applied separately to every page. The result
contains locations only:

```json
{
  "notion-page-id-1": [
    {
      "heading_id": "notion-heading-id",
      "heading_path": ["Release", "Approval"],
      "score": 0.92,
      "confidence": 0.88
    }
  ],
  "notion-page-id-2": []
}
```

`score` is the Choice probability within that page. Since there is no
`not_found` option, a low score means a weak match, not proof that the page
has no answer. A `heading_id` of `null` identifies the page preamble before
the first Heading.

## 3. Browse a selected section

Use `get-notion-heading-tree` when the LLM needs to inspect a page's Heading
hierarchy without loading body text.

```json
{ "page_id": "notion-page-id" }
```

Use `get-notion-section-content` with a selected `heading_id` to retrieve
only that logical section as Markdown. The returned section starts at that
Heading and ends before the next Heading of the same or higher level; nested
lower-level sections and physical Notion children are included.

```json
{
  "page_id": "notion-page-id",
  "heading_id": "notion-heading-id"
}
```

Pass `heading_id: null` to retrieve only content before the first Heading.
Child pages and child databases are document links, not section children, and
are excluded from the current page's tree.
