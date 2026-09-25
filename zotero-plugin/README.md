# Codeg Academic Bridge for Zotero

This Zotero 10 plugin connects the Codeg Academic workspace to your
personal Zotero library on the workspace backend machine. Zotero owns imported
records, collections, and PDFs.
Only Zotero 10.x is supported.
The plugin uses Zotero's native APIs and identifier translators; it does not
open the Zotero SQLite database.

## Build and install

Node.js 20 or newer is sufficient; no dependency installation is needed.

```sh
cd zotero-plugin
npm test
npm run build
```

In Zotero, open **Tools → Plugins**, select the gear menu, then **Install Plugin
From File…** and select `dist/codeg-academic-bridge-0.1.1.xpi`. Restart Zotero if
prompted.

Zotero rejects a plugin whose manifest lacks `applications.zotero.update_url`.
It points to [`updates.json`](updates.json) on this fork's `feat/academic-zotero`
branch, which lists no updates: install new versions manually from the fork's
preview releases.

The plugin uses Zotero's existing loopback HTTP server (default port **23119**).
Keep Zotero running. Its `httpServer.enabled` preference must be enabled;
`httpServer.port` determines the port Codeg must use. These settings are available
through Zotero's advanced configuration editor. The plugin does not change the
listener or its settings.

Open **Tools → Codeg Academic → Copy pairing token** and paste the token into
Codeg Academic settings with the local bridge port. The 256-bit random token is
stored in the local Zotero profile preferences; treat it as a local credential.
Use **Reset pairing token** to revoke existing pairing, then copy the new token.
The token is copied to the system clipboard only on your explicit menu action.

## Use

Select a collection and an existing paper in Codeg, or import a DOI/arXiv
identifier into an existing collection. Existing matching records are reused
and added to the selected collection. arXiv versions match the same record.
Identifier imports run through installed Zotero translators, so translator
updates and external metadata services must be available.

The bridge exposes only the personal library. Group libraries, collection
creation, arbitrary filesystem access, and direct remote/browser requests are
outside its scope. Web and remote-workspace users access it through the
authenticated Codeg Server API; Codeg and Zotero run on the same backend host. Codeg receives PDF locations from Zotero attachments; when a synced
attachment is unavailable locally, the bridge asks Zotero's sync runner to
download it. Any imported arXiv PDF is stored by Zotero as an attachment. Existing
PDFs are reused. The bridge requests text through Zotero’s native `attachmentText` API, which
uses its cache or PDF worker. Returned text is capped at 2,000,000 characters.
Unavailable text is `null`; Codeg may then extract text from the resolved PDF
using its backend extraction pipeline.

## HTTP protocol

All routes are `POST`, accept `Content-Type: application/json`, and require
`Authorization: Bearer <token>`. Send `{}` for methods without arguments.
Responses are JSON. No CORS grants are added, and requests with `Origin` or
`Sec-Fetch-Site` headers are rejected. A loopback `Host` is required, in addition
to Zotero's loopback listener. The Rust backend (desktop or server) calls this API; web pages do not call it
directly. In containers, Codeg must share loopback access and the attachment
paths with Zotero. See [server setup](../docs/academic-zotero.md).

| Route                    | Request                         | Response                                        |
| ------------------------ | ------------------------------- | ----------------------------------------------- |
| `/codeg/v1/health`       | `{}`                            | `{version: 1, instance_id}`                     |
| `/codeg/v1/library`      | `{}`                            | `{library_id, instance_id, collections, items}` |
| `/codeg/v1/import`       | `{identifier, collection_key}`  | Item metadata                                   |
| `/codeg/v1/attachment`   | `{item_key}`                    | `{attachment_key, path, text}`                  |
| `/codeg/v1/attach-arxiv` | `{item_key, arxiv_id, pdf_url}` | Attachment response                             |

`pdf_url` must be `https://arxiv.org/pdf/<arxiv_id>` (an optional `.pdf` suffix
is accepted). No other source URL, file path, or executable expression is
accepted. Attachment responses use null fields when no PDF exists, or a null
path when an existing attachment cannot be resolved.

Collections contain `key`, `name`, and nullable `parent_key`. Item metadata
contains `key`, `title`, `abstract_text`, `authors`, nullable `doi` and `url`,
`extra`, `collections` (keys), and `version`. Deleted records are excluded.

Errors use `{error: string}` with HTTP 400 for invalid input, 403 for failed
pairing/browser requests, 404 for missing records or collections, 422 when a
translator cannot resolve an identifier, and 500 for Zotero API failures. Check
Zotero's debug output for details of the latter; responses omit internal paths
and exception traces.

## Verification

Tests run the actual bridge logic with an in-memory substitute only for external
Zotero APIs. They cover authentication, browser/host rejection, personal-library
filtering, collection validation, DOI/arXiv deduplication, concurrent imports,
synced and linked attachment resolution, bounded native PDF text, nested
collections, library data readiness, restricted PDF imports, token revocation,
and bootstrap lifecycle cleanup. The build script produces a deterministic ZIP/XPI
without dependencies.

The endpoint and identifier-import interfaces, collection recursion, library data
loading, attachment imports, sync downloads, text extraction, and bootstrap
globals are reviewed against the
[Zotero 10.0 source branch](https://github.com/zotero/zotero/tree/10.0).

A real Zotero runtime is still required to verify translator/network behavior,
profile preferences, native HTTP endpoint integration, menu UI, and PDF sync.
For a manual smoke test on Zotero 10:

1. Install the XPI and pair Codeg using the Tools menu.
2. Refresh Codeg's library and check nested collections and paper metadata.
3. Import a known DOI twice into one collection, then into another collection;
   confirm one Zotero record belongs to both collections.
4. Import an arXiv identifier and retry with another version; confirm reuse.
5. Open a local PDF and a synced PDF that is not yet downloaded.
6. Reset the token; confirm the old pairing fails and the new token works.
7. Disable the plugin; confirm its Tools menu and HTTP routes disappear.
