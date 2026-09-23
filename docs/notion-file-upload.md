# Uploading files, images, and HTML blocks

`upload-notion-attachment` creates a Notion File Upload, sends the file, and appends one child block to a page or block. The three API steps are kept inside one MCP tool. The integration needs permission to edit the target page.

Input:

| Field | Required | Meaning |
| --- | --- | --- |
| `parent_id` | Yes | ID of the Notion page or block that receives the new child block. |
| `file_path` | One of `file_path` / `html_content` | Absolute path on the machine running this MCP server. |
| `html_content` | One of `file_path` / `html_content` | Inline HTML; the server writes a temporary `.html` file and removes it after the upload attempt. |
| `kind` | No | `file`, `image`, or `html`. By default, `.html`/`.htm` becomes an HTML embed, known image extensions become image blocks, and other files become file blocks. |
| `after` | No | Existing sibling block ID after which the new block should be placed. By default, appends at the end. |

Example image upload:

```json
{
  "parent_id": "NOTION_PAGE_ID",
  "file_path": "C:\\Workspace\\assets\\diagram.png"
}
```

Example inline HTML block:

```json
{
  "parent_id": "NOTION_PAGE_ID",
  "html_content": "<!doctype html><html><body><h1>Hello</h1></body></html>"
}
```

Example response:

```json
{
  "parent_id": "NOTION_PAGE_ID",
  "block_id": "NEW_NOTION_BLOCK_ID",
  "block_type": "embed",
  "file_upload_id": "NOTION_FILE_UPLOAD_ID",
  "filename": "index.html",
  "size_bytes": 55
}
```

The upload uses Notion API version `2026-03-11`. If you globally set `Notion-Version` via `OPENAPI_MCP_HEADERS`, that value overrides the tool's version and must support the File Upload and HTML embed APIs. Files up to 20 MiB use single-part upload; larger files use 10 MiB chunks and require a paid Notion workspace. Notion's own file-size and supported-format limits still apply. The tool uploads local files only; `file_path` is not read from the LLM user's computer unless that computer hosts the MCP server.

An HTML block is an `embed` block backed by an uploaded `.html` or `.htm` file, rendered in a sandboxed iframe. It is not raw HTML inserted into a paragraph. The returned `block_id` identifies the attached block. If a send or append step fails, an upload may remain unattached and expire according to Notion's File Upload lifecycle.
