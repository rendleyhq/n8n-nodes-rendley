<p align="center">
  <a href="https://rendley.com">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/rendleyhq/n8n-nodes-rendley/main/.github/assets/rendley-lockup-transparent-light-text.png">
      <img src="https://raw.githubusercontent.com/rendleyhq/n8n-nodes-rendley/main/.github/assets/rendley-lockup-transparent-dark-text.png" alt="Rendley" width="340">
    </picture>
  </a>
</p>

# n8n-nodes-rendley

[![npm](https://img.shields.io/npm/v/n8n-nodes-rendley)](https://www.npmjs.com/package/n8n-nodes-rendley) [![CI](https://github.com/rendleyhq/n8n-nodes-rendley/actions/workflows/ci.yml/badge.svg)](https://github.com/rendleyhq/n8n-nodes-rendley/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

[Rendley](https://rendley.com) lets you **create, edit, and automate video**. This node
puts Rendley in your n8n workflows. The **AI Video Agent** turns a plain-language prompt and
your footage into a finished video on a real editing timeline. Around it, AI media
operations generate video, images, music and speech and transform existing media, and
utility operations upload files, read brand kits, export MP4s and follow jobs.

This is an [n8n community node](https://docs.n8n.io/integrations/community-nodes/). It
has no runtime dependencies, talks only to the Rendley API through n8n's request
helpers, and is marked `usableAsTool`, so an n8n **AI Agent** can call any of its
operations.

[Installation](#installation) · [Credentials](#credentials) · [AI Video Agent](#ai-video-agent)
· [Other operations](#other-operations) · [Following long jobs](#following-long-jobs)
· [Templates](#templates) · [Development](#development) · [Release](#release)

## Installation

- **n8n Cloud and self-hosted 1.94+:** open the nodes panel, search for *Rendley*, and
  install it from the *More from the community* section (available once the package is
  verified by n8n).
- **Self-hosted, any version:** *Settings → Community Nodes → Install* and enter
  `n8n-nodes-rendley`.

Requires an n8n version that supports community nodes and Node.js 20 or newer on
self-hosted instances.

## Credentials

Create a **Rendley API** credential and paste an API key from
[app.rendley.com/settings](https://app.rendley.com/settings). The **API Base URL** is
pre-filled with `https://api.rendley.com/v1`; leave it unless Rendley gave you another
host. The credential test calls `GET /workspaces`.

AI actions, agent runs and exports use Rendley credits. When an operation cannot run,
Rendley answers with HTTP 402 and the node reports the message it sends.

## AI Video Agent

The **AI Video Agent** resource is the heart of the node. Give **Run** a prompt and,
optionally, some files, and the agent edits like a person would, on a real timeline it can
keep editing later.

- Turn raw footage into a social clip, reframed to 9:16 with captions and music.
- Cut bad takes, silences and filler words out of an interview or a talking-head recording.
- Add styled captions, titles and b-roll.
- Build a video from scratch from generated clips, images, voiceover and music.
- Reframe one video for several platforms.
- Apply any edit you can describe, and continue the conversation on the same project with
  a thread ID.

| Operation | What it does |
| --- | --- |
| **Run** | Sends the prompt, optional **Files** (public URLs, each imported into the project before the agent starts), an optional **Project** (leave it empty to create one) and an optional **Thread ID**. With **Export Video After Edit** on, the node exports the project once the edit lands and returns `url`. |
| **Get Job** | Reads an agent job without waiting, for workflows that poll on their own. |
| **Cancel Job** | Stops a running agent job. |

The output carries `job_id`, `project_id`, `thread_id`, `status`, `last_message` and
`commands_applied`, plus `url` and `export_job_id` when exported. The agent runs
non-interactively. If it pauses to ask a question the node fails with the question in
the error, so rephrase the prompt to remove the ambiguity.

The **Edit** resource offers the same agent behind curated prompts, so results are
repeatable. Every operation takes the project, optional files, **Export Video After
Edit**, and an **Additional Instructions** option. Reframe takes an aspect ratio (9:16,
1:1, 4:5, 16:9), Create Shorts takes a count and length bounds, Remove Filler Words a
minimum silence.

## Other operations

Most operations are asynchronous. The node starts a job and, when **Wait for
Completion** is on (the default), polls until it finishes. **Poll Interval (Seconds)**
(default 10, minimum 5) and **Timeout (Minutes)** (default 60) are set per operation.

| Resource | Operations |
| --- | --- |
| **Edit** | Remove Filler Words, Auto Edit, Reframe, Add Captions, Create Shorts, Custom Prompt |
| **Video** | Generate, Transcribe, Dub, Lip Sync, Isolate Voice, Change Voice, Remove Background, Upscale |
| **Image** | Generate, Upscale, Remove Background |
| **Audio** | Text to Speech, Generate Music, Generate Sound Effect |
| **Export** | Export Video, Estimate Cost, Get Job |
| **Media** | Upload, Get Download URL, List |
| **Brand Kit** | Get, Import From Website |
| **Project** | Create, Get, List, Delete |

### Video, Image and Audio

Each AI operation takes an optional **Project** (leave it empty to save the result to the
workspace library, with a **Workspace** picker for accounts that have several), an
optional **Model** picked from the models that action supports, its typed options, an
**Additional Parameters (JSON)** escape hatch for model-specific fields documented in the
[model catalog](https://docs.rendley.com/api/models), and an **Estimate Cost Only** toggle
that returns the credit price without running anything.

Source files (Transcribe, Dub, Lip Sync, Isolate Voice, Change Voice, Remove Background,
Upscale) accept a **public URL, a media ID, or the file hash** of an upload in the
project. Rendley resolves the reference and probes duration itself.

When the node waits for completion the output carries `url` (a fresh signed
URL), `url_expires_at`, `media_id` and `file_hash`. Transcribe returns the transcript in
`result_data` instead of a file.

### Export

**Export Video** exports a project with **Export Settings** (codec, quality, target
resolution) and returns `url` when waiting. **Estimate Cost** returns the credit
price. **Get Job** reads any Rendley job by ID.

### Media

- **Upload** puts a file into a project. **Source** is either **Binary Data** (a file from
  an earlier node such as Google Drive or an email attachment, up to 50 MB) or a public
  **URL**, which Rendley fetches server-side with no size limit through n8n. Returns
  `media_id` and `file_hash`, both usable as the file reference of AI operations.
- **Get Download URL** resolves a media ID or file hash to a fresh signed URL.
- **List** returns every upload in a project with a fresh `url`.

Signed URLs expire after a few hours. Copy files to your own storage in the same
workflow rather than saving a Rendley URL for later.

### Brand Kit and Project

Read a workspace brand kit or import one from a public website. Create, get (with a
**Simplify** toggle that leaves out the editor document), list and delete projects.
Leaving the workspace empty uses the account's first workspace.

## Following long jobs

For jobs that can run for many minutes, or for large batches, turn **Wait for
Completion** off and poll yourself with an n8n **Wait** node of 70 seconds or more, then
**AI Video Agent > Get Job** or **Export > Get Job**, then an **If** that loops until `status` is
`completed`. n8n offloads waits of that length, so they cost no execution time. Rendley
sends no outbound webhooks.

## Templates

Ready-to-import workflows live in [`templates/`](templates/). Each carries sticky notes
covering the rough credit cost and the link-expiry warning. See
[`templates/README.md`](templates/README.md).

## Development

```bash
npm install
npm run typecheck   # tsc
npm run lint        # n8n-node lint (the ruleset n8n verifies with)
npm run build       # n8n-node build -> dist/
npm test            # drives the compiled node against a stub of the Rendley API
npm run scan        # @n8n/scan-community-package on the built package
npm run dev         # runs n8n locally with this node linked
```

`npm run test:live` runs the compiled node against a real Rendley API. It needs
`RENDLEY_API_KEY` (it spends a few credits) and optionally
`RENDLEY_API_BASE_URL`.

## Release

Publishing goes through GitHub Actions with npm provenance, as n8n requires for
verified community nodes.

## License

[MIT](LICENSE)
