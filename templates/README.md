# Workflow templates

Importable n8n workflows built on the Rendley node. In n8n choose *Import from file*
and pick a JSON file. Each workflow carries sticky notes that explain the paid-plan
requirement, roughly what a run costs in credits, and why links must be copied out.

Replace the `REPLACE_WITH_CREDENTIAL_ID`, `PASTE_…` and `YOUR_…` placeholders with your
own values.

| File | Trigger | What it does | Rendley operations |
| --- | --- | --- | --- |
| [`n8n-ai-video-agent.json`](n8n-ai-video-agent.json) | Manual | AI Video Agent with **Export Video After Edit**, the whole flow in one node | Agent |
| [`n8n-long-form-to-shorts.json`](n8n-long-form-to-shorts.json) | Webhook (video URL) | Transcribe, pick a moment, cut, reframe 9:16, add captions, export, copy to Drive | Agent |
| [`n8n-remove-filler-words.json`](n8n-remove-filler-words.json) | Webhook (video URL) | Remove fillers and trim silences, export, copy to Drive | Agent |
| [`n8n-multi-aspect-fanout.json`](n8n-multi-aspect-fanout.json) | Manual (master project) | Loop 9:16, 1:1, 4:5 and 16:9: reframe, export each, copy to Drive | Edit (Reframe) |
| [`n8n-dubbing-pipeline.json`](n8n-dubbing-pipeline.json) | Webhook (video and language) | Dub a video into another language and copy the result to Drive | Project, Video (Dub) |
| [`n8n-transcript-to-content.json`](n8n-transcript-to-content.json) | Webhook (video URL) | Transcribe, then an LLM writes a blog post, show notes and social copy | Project, Video (Transcribe) |
| [`n8n-product-photo-to-video-ad.json`](n8n-product-photo-to-video-ad.json) | Webhook (image URL) | Animate a product photo into a short video ad and copy it to Drive | Project, Video (Generate) |
| [`n8n-catalogue-video-at-scale.json`](n8n-catalogue-video-at-scale.json) | Schedule | Sheet rows to inline-project exports, polled with a Wait loop, written back | Export (Get Job) plus raw HTTP export |
| [`n8n-brandkit-from-website.json`](n8n-brandkit-from-website.json) | Webhook (site URL) | Import a brand kit from a public website and read it back | Brand Kit |

## Patterns

- **Wait inline.** Most templates leave **Wait for Completion** on, so the node polls
  Rendley and the workflow stays one linear chain.
- **Poll with a Wait node.** The catalogue template starts jobs without waiting and
  loops **Wait (70 s or more) → Get Job → If**. n8n offloads waits of that length, so
  they cost no execution time. Use this for batches or very long renders.
- **Copy files out.** Rendley download and export URLs are signed and expire after a
  few hours. Every template that produces a file downloads it and re-uploads it to
  your own storage in the same run.
- **Credits.** The agent, AI actions and exports use Rendley credits. When an operation cannot run, Rendley answers with an error that the node passes through with its message.
  otherwise) and AI actions consume credits. Use the node's **Estimate Cost Only**
  toggle or **Export > Estimate Cost** for an exact quote.
