# Changelog

## 1.0.0

- First release from the package's own repository, [rendleyhq/n8n-nodes-rendley](https://github.com/rendleyhq/n8n-nodes-rendley), versioned 1.x like the other Rendley integrations. The `credentials/` folder is at the repository root by itself, so the build no longer mirrors it. No functional changes since 0.2.2.

## 0.2.2

- The credential connection test calls `GET /users/me` instead of `GET /workspaces`, matching the Make integration. It checks the API key itself rather than a workspace listing.
- The Rendley API credential is now also written to a `credentials/` folder at the repository root when the package is built. The n8n Creator Portal verification check looks for the credential there and does not follow the monorepo subfolder.

## 0.2.1

- The export download link is read from `output.url`, which `GET /jobs/{id}` presigns fresh on every read, rather than the copy stored in `result_data`. A stored link is presigned once when the render finishes and expires on its own schedule, so it could hand back a dead URL for a job polled later.

## 0.2.0

- Render Video is now Export Video and Render MP4 After Edit is now Export Video After Edit, matching the other integrations. Parameter values are unchanged.
- New Video > Upscale operation.
- The Agent resource is now AI Video Agent, with Run, Get Job and Cancel Job operations.
- AI actions no longer require a project. Leave Project empty to save the result to the workspace library, with a Workspace picker for accounts with several workspaces.
- Output fields follow the Rendley API. The download link is `url` (was `download_url` and `video_url`), the parsed job result is `result_data` (was `result`), and completed jobs include the raw `job`.
- Files given to AI Video Agent and Edit operations are imported into the project through the Rendley API before the agent starts, so every attachment is complete when the agent reads it. When files are given without a project, the node creates a project named from the prompt.
- AI Video Agent > Run returns `commands_applied` and `export_job_id`, and skips the export when the agent made no changes.
- The README leads with the AI Video Agent and groups the other resources around it.
- Waiting for a job survives transient network errors, rate limits and server errors instead of failing the node, so long jobs are safe to wait for. When Timeout (Minutes) ends first, the error names the job ID and how to read it with Get Job, and the job continues on Rendley.

## 0.1.3

- Brand assets moved out of the package; the npm tarball now contains only the node, credential and icons.

## 0.1.2

- Built with @n8n/node-cli 0.47 against n8n-workflow 2.x. No functional changes.

## 0.1.1

- Published from GitHub Actions with npm provenance. No functional changes.

## 0.1.0

- Initial release. Rendley node with Agent, Edit, Video, Image, Audio, Export, Media,
  Brand Kit and Project resources, a Rendley API credential with a connection test,
  and nine importable workflow templates.
