import { randomUUID } from 'node:crypto';

import { NodeApiError, NodeConnectionTypes, NodeOperationError, sleep } from 'n8n-workflow';
import type {
	IDataObject,
	IExecuteFunctions,
	IHttpRequestMethods,
	IHttpRequestOptions,
	ILoadOptionsFunctions,
	INodeExecutionData,
	INodeListSearchResult,
	INodePropertyOptions,
	INodeProperties,
	INodeType,
	INodeTypeDescription,
	JsonObject,
} from 'n8n-workflow';

import { xxhash64Hex } from './xxhash';

/** Every context that is allowed to talk to the Rendley API. */
type RendleyContext = IExecuteFunctions | ILoadOptionsFunctions;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parses the `result_data` field returned by the REST job endpoint. The API
 * returns it as a JSON string, but we defensively accept objects too.
 */
function parseResultData(raw: unknown): IDataObject | undefined {
	if (raw === undefined || raw === null || raw === '') {
		return undefined;
	}
	if (typeof raw === 'object') {
		return raw as IDataObject;
	}
	if (typeof raw === 'string') {
		try {
			return JSON.parse(raw) as IDataObject;
		} catch {
			return undefined;
		}
	}
	return undefined;
}

/**
 * Builds an export `settings` object from a collection value, omitting any
 * unset fields so we never send empty strings to the API.
 */
function buildSettings(raw: IDataObject): IDataObject | undefined {
	const settings: IDataObject = {};
	if (raw.codec) {
		settings.codec = raw.codec;
	}
	if (raw.target_resolution) {
		settings.target_resolution = raw.target_resolution;
	}
	if (raw.quality) {
		settings.quality = raw.quality;
	}
	return Object.keys(settings).length > 0 ? settings : undefined;
}

/**
 * Wraps a request/HTTP error into a NodeApiError with a clear, English message.
 * Surfaces the Rendley envelope error and a friendly note for HTTP 402.
 */
function toApiError(ctx: RendleyContext, error: unknown): NodeApiError {
	const err = error as {
		httpCode?: string | number;
		statusCode?: string | number;
		message?: string;
		response?: { status?: number; body?: unknown; data?: unknown };
		error?: unknown;
	};

	const status = err?.httpCode ?? err?.response?.status ?? err?.statusCode;
	const bodySource = err?.response?.body ?? err?.response?.data ?? err?.error ?? {};
	const body = (typeof bodySource === 'object' && bodySource !== null ? bodySource : {}) as IDataObject;
	const enveloped = (body.error && typeof body.error === 'object' ? body.error : undefined) as
		| IDataObject
		| undefined;

	let message =
		(enveloped?.message as string) || err?.message || 'The Rendley API request failed.';

	if (String(status) === '402') {
		message = `Rendley: payment required. ${
			(enveloped?.message as string) ||
			'This operation requires an active subscription and available credits.'
		}`;
	}

	return new NodeApiError(ctx.getNode(), err as JsonObject, {
		message,
		httpCode: status !== undefined ? String(status) : undefined,
	});
}

/** Keeps an already-shaped n8n error, shapes anything else (bad JSON, helper failures). */
function asNodeError(ctx: RendleyContext, error: unknown): NodeApiError | NodeOperationError {
	if (error instanceof NodeApiError || error instanceof NodeOperationError) return error;
	return toApiError(ctx, error);
}

/** HTTP status of a failed request, as a string, or an empty string. */
function errorStatus(error: unknown): string {
	const err = error as {
		httpCode?: string | number;
		statusCode?: string | number;
		response?: { status?: number };
	};
	const status = err?.httpCode ?? err?.response?.status ?? err?.statusCode;
	return status === undefined ? '' : String(status);
}

/**
 * Performs an authenticated request against the Rendley API and unwraps the
 * `{ data }` envelope every route answers with.
 */
async function rendleyRequest<T = IDataObject>(
	ctx: RendleyContext,
	method: IHttpRequestMethods,
	path: string,
	body?: IDataObject,
): Promise<T> {
	const credentials = await ctx.getCredentials('rendleyApi');
	const baseURL = (credentials.apiBaseUrl as string) || 'https://api.rendley.com/v1';

	const options: IHttpRequestOptions = {
		method,
		url: path,
		baseURL,
		json: true,
	};
	if (body !== undefined) {
		options.body = body;
	}

	let response: unknown;
	try {
		response = await ctx.helpers.httpRequestWithAuthentication.call(ctx, 'rendleyApi', options);
	} catch (error) {
		throw toApiError(ctx, error);
	}

	if (
		response &&
		typeof response === 'object' &&
		!Array.isArray(response) &&
		'data' in response
	) {
		return (response as IDataObject).data as T;
	}
	return response as T;
}

/** Both /projects calls reject a missing workspace_id, so an empty field takes the first one. */
async function resolveWorkspaceId(ctx: RendleyContext, workspaceId: string): Promise<string> {
	if (workspaceId) {
		return workspaceId;
	}
	const workspaces = await rendleyRequest<IDataObject[] | undefined>(ctx, 'GET', '/workspaces');
	const first = workspaces?.[0]?.id as string | undefined;
	if (!first) {
		throw new NodeOperationError(
			ctx.getNode(),
			'No workspace found for this Rendley API key. Create one at app.rendley.com.',
		);
	}
	return first;
}

/** The API validates against the model's own schema, so a mismatched model errors on an unrelated field. */
async function assertModelMatchesAction(
	ctx: IExecuteFunctions,
	action: string,
	modelId: string,
): Promise<void> {
	const tools = await rendleyRequest<IDataObject[] | undefined>(ctx, 'GET', '/ai/tools');
	// The catalog spells actions with underscores, the endpoints with hyphens.
	const catalogAction = action.replace(/-/g, '_');
	const tool = tools?.find((entry) => entry.action === catalogAction);
	const modelIds = ((tool?.models as IDataObject[] | undefined) ?? []).map(
		(model) => model.id as string,
	);
	if (modelIds.length > 0 && !modelIds.includes(modelId)) {
		throw new NodeOperationError(
			ctx.getNode(),
			`Model "${modelId}" is not available for "${action}". Pick one of: ${modelIds.join(', ')}.`,
		);
	}
}

/** The workspace list shared by every workspace picker, sorted A-Z. */
async function loadWorkspaceOptions(ctx: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
	const workspaces = await rendleyRequest<IDataObject[] | undefined>(ctx, 'GET', '/workspaces');
	if (!Array.isArray(workspaces)) {
		return [];
	}
	return workspaces
		.map((workspace) => ({
			name: (workspace.name as string) || (workspace.id as string),
			value: workspace.id as string,
		}))
		.sort((a, b) => a.name.localeCompare(b.name));
}

/** The project list shared by every project picker, newest names sorted A-Z. */
async function loadProjectOptions(ctx: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
	const workspaceId = await resolveWorkspaceId(ctx, '');
	const projects = await rendleyRequest<IDataObject[] | undefined>(
		ctx,
		'GET',
		`/projects?workspace_id=${encodeURIComponent(workspaceId)}`,
	);
	if (!Array.isArray(projects)) {
		return [];
	}
	return projects
		.map((project) => ({
			name: (project.name as string) || (project.id as string),
			value: project.id as string,
		}))
		.sort((a, b) => a.name.localeCompare(b.name));
}

/** A locator, not an options list: in a workflow the project is created a step earlier. */
function projectLocator(
	displayOptions: INodeProperties['displayOptions'],
	spec: { required?: boolean; defaultMode?: 'list' | 'id'; description: string },
): INodeProperties {
	return {
		displayName: 'Project',
		name: 'projectId',
		type: 'resourceLocator',
		default: { mode: spec.defaultMode ?? 'list', value: '' },
		required: spec.required,
		displayOptions,
		description: spec.description,
		modes: [
			{
				displayName: 'From List',
				name: 'list',
				type: 'list',
				typeOptions: { searchListMethod: 'searchProjects', searchable: true },
			},
			{
				displayName: 'By ID',
				name: 'id',
				type: 'string',
				placeholder: 'e.g. 1fdfc335-a483-4f8d-8466-8dae94175cc6',
			},
		],
	};
}

/** A project name derived from the prompt, the way the Rendley app names agent projects. */
function agentProjectName(prompt: string): string {
	const oneLine = prompt.replace(/\s+/g, ' ').trim();
	return oneLine.length > 60 ? `${oneLine.slice(0, 59).trimEnd()}…` : oneLine || 'AI Video Agent';
}

/** The signed MP4 URL of a completed export: `output.url`, presigned fresh by the API on every read. */
function exportVideoUrl(job: IDataObject): string | undefined {
	const output = job.output as IDataObject | undefined;
	return (output?.url as string | undefined) || undefined;
}

/** `error` arrives as a plain string on some responses and wrapped in `{ message }` on others. */
function jobFailureMessage(job: IDataObject, fallback: string): string {
	const error = job.error;
	if (typeof error === 'string' && error !== '') {
		return error;
	}
	const wrapped = (error as IDataObject | undefined)?.message;
	if (typeof wrapped === 'string' && wrapped !== '') {
		return wrapped;
	}
	const lastMessage = job.last_message;
	if (typeof lastMessage === 'string' && lastMessage !== '') {
		return lastMessage;
	}
	return fallback;
}

/** Last path segment of a URL, used when no file name was given. */
function fileNameFromUrl(url: string): string {
	const path = url.split('?')[0] ?? '';
	const last = path.split('/').filter(Boolean).pop();
	return last && last !== '' ? last : 'upload';
}

/** Register, PUT the bytes, confirm. The returned `media_id` and `file_hash` both work as AI media references. */
async function uploadBytes(
	ctx: IExecuteFunctions,
	projectId: string,
	data: Buffer,
	fileName: string,
	mimeType: string,
	itemIndex: number,
): Promise<IDataObject> {
	if (data.byteLength === 0) {
		throw new NodeOperationError(ctx.getNode(), 'The file is empty, nothing to upload.', {
			itemIndex,
		});
	}
	if (data.byteLength > MULTIPART_THRESHOLD_BYTES) {
		throw new NodeOperationError(
			ctx.getNode(),
			`The file is ${Math.round(data.byteLength / 1024 / 1024)} MB. Files above ${
				MULTIPART_THRESHOLD_BYTES / 1024 / 1024
			} MB need Rendley's multipart upload, which this node does not support yet. Host the file on a URL and use Source > URL instead.`,
			{ itemIndex },
		);
	}

	const mediaId = randomUUID();
	const fileHash = xxhash64Hex(new Uint8Array(data));
	const created = (await rendleyRequest(
		ctx,
		'POST',
		`/projects/${encodeURIComponent(projectId)}/uploads`,
		{
		project_id: projectId,
		media_id: mediaId,
		file_hash: fileHash,
		file_size: data.byteLength,
		original_file_name: fileName,
		mime_type: mimeType,
			// The editor's hash sync deletes `library` rows the project JSON does not reference.
			role: 'pending',
		},
	)) as IDataObject;

	// No auth header: the Content-Type must match the one registered above.
	await ctx.helpers.httpRequest({
		method: 'PUT',
		url: created.presigned_url as string,
		body: data,
		headers: { 'Content-Type': mimeType },
		json: false,
	});

	await rendleyRequest(
		ctx,
		'POST',
		`/projects/${encodeURIComponent(projectId)}/uploads/${encodeURIComponent(
			created.upload_id as string,
		)}/complete`,
	);

	return {
		media_id: mediaId,
		file_hash: fileHash,
		upload_id: created.upload_id,
		file_name: fileName,
		mime_type: mimeType,
		size: data.byteLength,
	};
}

const DEFAULT_POLL_INTERVAL_SECONDS = 10;
const MIN_POLL_INTERVAL_SECONDS = 5;
const DEFAULT_POLL_TIMEOUT_MINUTES = 60;
/** Rendley switches to a multipart flow above this size; the editor uses the same figure. */
const MULTIPART_THRESHOLD_BYTES = 50 * 1024 * 1024;

/** Reads the per-operation wait ceiling, so long jobs can be given up on. */
function pollTimeoutMs(ctx: IExecuteFunctions, itemIndex: number): number {
	const minutes = ctx.getNodeParameter(
		'pollTimeout',
		itemIndex,
		DEFAULT_POLL_TIMEOUT_MINUTES,
	) as number;
	const safe = Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_POLL_TIMEOUT_MINUTES;
	return safe * 60 * 1000;
}

/** Reads the per-operation poll interval, clamped to the documented minimum. */
function pollIntervalMs(ctx: IExecuteFunctions, itemIndex: number): number {
	const seconds = ctx.getNodeParameter(
		'pollInterval',
		itemIndex,
		DEFAULT_POLL_INTERVAL_SECONDS,
	) as number;
	const safe = Number.isFinite(seconds) ? seconds : DEFAULT_POLL_INTERVAL_SECONDS;
	return Math.max(MIN_POLL_INTERVAL_SECONDS, safe) * 1000;
}

/** Consecutive poll failures tolerated before a wait gives up. */
const POLL_MAX_TRANSIENT_FAILURES = 5;

/** A dropped connection, a rate limit or a server error, which a later poll may not hit. */
function isTransientPollError(error: unknown): boolean {
	const err = error as { httpCode?: string | number; message?: string };
	const code = err?.httpCode !== undefined ? Number(err.httpCode) : undefined;
	if (code !== undefined && !Number.isNaN(code)) return code === 429 || code >= 500;
	return /ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|socket hang up|fetch failed|network|timed? ?out/i.test(
		err?.message ?? '',
	);
}

/**
 * Reads a job while waiting for it. A job that runs for many minutes will
 * see the odd network blip, so transient failures are retried with a growing
 * pause instead of failing the wait and losing the job.
 */
async function pollFetch(
	ctx: IExecuteFunctions,
	path: string,
	intervalMs: number,
	state: { failures: number },
): Promise<IDataObject | undefined> {
	// rendleyRequest already maps failures to NodeApiError, so the error is
	// kept as it is rather than wrapped again.
	const result = await rendleyRequest(ctx, 'GET', path).then(
		(job) => ({ job }),
		(error: NodeApiError) => ({ error }),
	);
	if ('job' in result) {
		state.failures = 0;
		return result.job;
	}
	state.failures += 1;
	if (!isTransientPollError(result.error) || state.failures > POLL_MAX_TRANSIENT_FAILURES) {
		throw result.error;
	}
	await sleep(Math.min(intervalMs * state.failures, 30_000));
	return undefined;
}

/** The error for a wait that outlived its Timeout (Minutes); the job itself keeps running on Rendley. */
function pollTimeoutError(
	ctx: IExecuteFunctions,
	kind: string,
	jobId: string,
	timeoutMs: number,
	status: unknown,
	getJobHint: string,
): NodeOperationError {
	return new NodeOperationError(
		ctx.getNode(),
		`The Rendley ${kind} "${jobId}" is still ${status ?? 'running'} after ${Math.round(
			timeoutMs / 60_000,
		)} minutes, so this node stopped waiting. The job continues on Rendley.`,
		{
			description: `Raise Timeout (Minutes) to wait longer, or turn Wait for Completion off and read the job later with ${getJobHint} using job ID ${jobId}.`,
		},
	);
}

/**
 * Polls an agent job until it reaches a terminal state (completed/failed).
 */
async function pollAgentJob(
	ctx: IExecuteFunctions,
	jobId: string,
	intervalMs: number,
	timeoutMs: number,
): Promise<IDataObject> {
	const start = Date.now();
	const state = { failures: 0 };
	while (true) {
		const job = await pollFetch(ctx, `/agent/jobs/${encodeURIComponent(jobId)}`, intervalMs, state);
		if (!job) continue;
		const status = job?.status;
		if (
			status === 'completed' ||
			status === 'failed' ||
			status === 'canceled' ||
			status === 'cancelled'
		) {
			return job;
		}
		// Automation jobs run non-interactively, so a pause means nobody can answer it.
		if (status === 'waiting_input') {
			const question = (job?.interrupt as IDataObject | undefined)?.summary;
			throw new NodeOperationError(
				ctx.getNode(),
				`The Rendley agent paused job "${jobId}" to ask a question${
					question ? `: ${question}` : ''
				}. Rephrase the prompt so the agent does not need to ask, or answer it in the Rendley app.`,
			);
		}
		if (Date.now() - start > timeoutMs) {
			throw pollTimeoutError(ctx, 'agent job', jobId, timeoutMs, status, 'AI Video Agent > Get Job');
		}
		await sleep(intervalMs);
	}
}

/**
 * Polls a REST job until it reaches a terminal state
 * (completed/failed/canceled).
 */
async function pollApiJob(
	ctx: IExecuteFunctions,
	jobId: string,
	intervalMs: number,
	timeoutMs: number,
): Promise<IDataObject> {
	const start = Date.now();
	const state = { failures: 0 };
	while (true) {
		const job = await pollFetch(ctx, `/jobs/${encodeURIComponent(jobId)}`, intervalMs, state);
		if (!job) continue;
		const status = job?.status;
		if (status === 'completed' || status === 'failed' || status === 'canceled' || status === 'cancelled') {
			return job;
		}
		if (Date.now() - start > timeoutMs) {
			throw pollTimeoutError(ctx, 'job', jobId, timeoutMs, status, 'Export > Get Job');
		}
		await sleep(intervalMs);
	}
}

// ---------------------------------------------------------------------------
// Media resolution
// ---------------------------------------------------------------------------

/**
 * Resolves a media reference to a freshly presigned download URL.
 *
 * Resolved from the uploads listing, which carries `media_id`, `file_hash` and a
 * freshly presigned `storage_url` for every row. There is no per-media route in
 * the API.
 */
async function resolveMediaUrl(
	ctx: IExecuteFunctions,
	projectId: string,
	mediaId?: string,
	fileHash?: string,
): Promise<IDataObject | undefined> {
	if (fileHash) {
		try {
			const upload = (await rendleyRequest(
				ctx,
				'GET',
				`/projects/${encodeURIComponent(projectId)}/uploads?hash=${encodeURIComponent(fileHash)}`,
			)) as IDataObject;
			if (upload && typeof upload === 'object' && upload.storage_url) {
				return {
					...upload,
					media_id: mediaId,
					url: upload.storage_url,
					resolved_via: 'uploads_by_hash',
				};
			}
		} catch (error) {
			if (errorStatus(error) !== '404') {
				throw asNodeError(ctx, error);
			}
		}
	}

	const uploads = await rendleyRequest<IDataObject[] | undefined>(
		ctx,
		'GET',
		`/projects/${encodeURIComponent(projectId)}/uploads`,
	);
	if (!Array.isArray(uploads)) {
		return undefined;
	}
	const match = uploads.find(
		(upload) =>
			(fileHash !== undefined && upload.file_hash === fileHash) ||
			(mediaId !== undefined && upload.media_id === mediaId),
	);
	if (!match) {
		return undefined;
	}
	return {
		...match,
		media_id: (match.media_id as string) ?? mediaId,
		url: match.storage_url,
		resolved_via: 'uploads_list',
	};
}

// ---------------------------------------------------------------------------
// AI actions
// ---------------------------------------------------------------------------

/** Maps every `resource:operation` pair to its `POST /ai/{action}` path segment. */
const AI_ACTIONS: Record<string, string> = {
	'video:transcribe': 'transcribe',
	'video:dub': 'video-translate',
	'video:lipSync': 'lipsync',
	'video:isolateVoice': 'voice-isolation',
	'video:changeVoice': 'voice-changer',
	'video:removeBackground': 'remove-video-background',
	'video:generate': 'generate-video',
	// generate-video-avatar is commented out in the API ("avatar generation is not working").
	// Restore this pair, the operation and the getAvatars loader when it returns.
	'image:generate': 'generate-image',
	'image:upscale': 'upscale-image',
	'video:upscale': 'upscale-video',
	'image:removeBackground': 'remove-image-background',
	'audio:textToSpeech': 'text-to-speech',
	'audio:generateMusic': 'generate-music',
	'audio:generateSoundEffect': 'generate-sound-effect',
};

/**
 * Extracts the job id from an AI enqueue response. `POST /ai/{action}` answers
 * with `{ data: { job_id } }`; older deployments answered with a bare string.
 */
function extractJobId(ctx: IExecuteFunctions, response: unknown, itemIndex: number): string {
	if (typeof response === 'string' && response !== '') {
		return response;
	}
	if (response && typeof response === 'object') {
		const asObject = response as IDataObject;
		const candidate = (asObject.job_id ?? asObject.id) as string | undefined;
		if (candidate) {
			return candidate;
		}
	}
	throw new NodeOperationError(
		ctx.getNode(),
		'Rendley did not return a job ID for this AI action.',
		{ itemIndex },
	);
}

/** Copies a value into `params` only when the user actually set it. */
function setParam(params: IDataObject, key: string, value: unknown): void {
	if (value === undefined || value === null || value === '') {
		return;
	}
	params[key] = value;
}

/** Splits a comma or newline separated list into trimmed, non-empty entries. */
function splitList(raw: string): string[] {
	return raw
		.split(/[\n,]/)
		.map((entry) => entry.trim())
		.filter((entry) => entry !== '');
}

/**
 * Merges the free-form "Additional Parameters" JSON escape hatch into the
 * params built from the typed fields.
 */
function mergeExtraParams(
	ctx: IExecuteFunctions,
	params: IDataObject,
	raw: string,
	itemIndex: number,
): IDataObject {
	const trimmed = (raw ?? '').trim();
	if (trimmed === '') {
		return params;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		throw new NodeOperationError(
			ctx.getNode(),
			'Additional Parameters must be a JSON object, for example {"seed": 42}.',
			{ itemIndex },
		);
	}
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		throw new NodeOperationError(
			ctx.getNode(),
			'Additional Parameters must be a JSON object, not an array or a primitive.',
			{ itemIndex },
		);
	}
	return { ...params, ...(parsed as IDataObject) };
}

// ---------------------------------------------------------------------------
// Edit prompt templates
// ---------------------------------------------------------------------------

/**
 * The Edit resource is a set of curated prompts for the same `POST /agent`
 * endpoint the Agent resource uses. The wording is what makes the results
 * repeatable, so each template names the exact SDK commands the agent should
 * reach for and the traps it should avoid.
 */
function buildEditPrompt(
	ctx: IExecuteFunctions,
	operation: string,
	itemIndex: number,
): string {
	const options = ctx.getNodeParameter('editOptions', itemIndex, {}) as IDataObject;
	const instructions = ((options.extraInstructions as string) || '').trim();

	let prompt: string;

	switch (operation) {
		case 'removeFillerWords': {
			const silence = (options.minSilenceSeconds as number) ?? 0.6;
			prompt = [
				'Clean up the spoken audio in this project so it sounds tighter without sounding chopped.',
				'',
				'1. Call getTimelineClips and getClipData to find every video or audio clip that contains speech.',
				'2. Transcribe each of those clips (transcribe action, pass the clip_id) and wait for the word-level transcript before editing anything. Do not guess at timings.',
				'3. From the word timestamps, collect the ranges to cut: filler words and disfluencies ("um", "uh", "er", "ah", "mm", "like" used as filler, "you know", "I mean", "sort of", "kind of", "basically" and "actually" when they carry no meaning), stutters and repeated words, false starts, and abandoned sentences.',
				`4. Also collect every silence longer than ${silence} seconds. Trim each silence down to roughly ${silence} seconds rather than removing it entirely, so the delivery keeps its natural rhythm.`,
				'5. Express every cut as an explicit { start, end } range in seconds. Merge ranges that are less than 0.12 s apart, and pad each range inward by about 0.03 s so the cut lands in the silence instead of clipping the neighbouring word.',
				'6. Apply the cuts with removeClipSegments using space "trim" and the segments array. Edit the existing clips - do not delete and rebuild them, and do not touch clips that contain no speech.',
				'7. Never cut a word that carries meaning, never cut mid-word, and never remove a breath that makes a sentence readable.',
				'',
				'When you are done, report the number of ranges removed, the total seconds saved, and the new duration.',
			].join('\n');
			break;
		}
		case 'autoEdit': {
			const targetDuration = options.targetDurationSeconds as number | undefined;
			const style = ((options.style as string) || '').trim();
			prompt = [
				`Do a full editorial pass on this project and turn the raw footage into a tight, watchable cut${
					targetDuration ? ` of about ${targetDuration} seconds` : ''
				}.`,
				'',
				'1. Call getTimelineClips, getClipData and getDisplaySize to understand what is on the timeline.',
				'2. Transcribe every clip that contains speech so you can edit against word-level timestamps instead of guessing.',
				'3. Decide the narrative: a hook in the first 3 seconds, the substance in the middle, and a clean ending. Everything that does not serve that arc is a candidate for removal.',
				'4. Remove dead air, filler words, false starts, tangents, and repeated takes with removeClipSegments and explicit { start, end } ranges. When a line was recorded more than once, keep the single best take and drop the rest.',
				'5. Re-order what remains so the story flows, using moveClip and setClipStartTime, and close every gap on the timeline so there is no black frame between clips.',
				'6. Add a transition only where there is a genuine scene change. Do not put transitions between cuts inside one continuous take.',
				'7. Balance the audio: run enhanceAudio on the speech clips, and if there is a music bed keep it well under the voice with setClipVolume.',
				'',
				'Do not add captions and do not change the aspect ratio unless explicitly asked. Report the cut list you applied and the final duration.',
				style ? `\nEditorial style to aim for: ${style}.` : '',
			].join('\n');
			break;
		}
		case 'reframe': {
			const ratio = (options.aspectRatio as string) || '9:16';
			prompt = [
				`Reframe this project to ${ratio}.`,
				'',
				'1. Call getDisplaySize and getTimelineClips so you know the current canvas and every video clip on the timeline.',
				`2. For each video clip, call reframeClip with ratio "${ratio}". reframeClip runs subject detection and writes position keyframes that pan to keep the subject in frame, so it is the right tool here - do NOT use setClipCrop, which is a static, non-tracking crop.`,
				`3. Leave resizeCanvas at its default (true) on the FIRST reframeClip call: that resizes the project canvas to ${ratio} and cover-fits the clip. For every clip after that, pass resizeCanvas: false, because the canvas is already correct. Never emit setDisplaySize for ${ratio} yourself - reframeClip has already done it.`,
				'4. Keep useActiveSpeaker and usePose at their defaults so talking heads and people facing away are both tracked.',
				'5. reframeClip only works on video clips. For images, shapes, text, and motion clips, reposition or rescale them so they still sit inside the new canvas.',
				'6. After reframing, re-check every text, title, subtitle and logo element: anything now outside the canvas or inside the platform safe area must be moved or resized.',
				'',
				'Report the axis and keyframe count reframeClip returned for each clip, and note any clip that came back with axis NONE.',
			].join('\n');
			break;
		}
		case 'addCaptions': {
			const language = ((options.language as string) || '').trim();
			const style = ((options.captionStyle as string) || '').trim();
			prompt = [
				'Add accurate, readable captions to this project.',
				'',
				'1. Call getTimelineClips and identify every clip that contains speech.',
				`2. Transcribe each speech clip${
					language ? ` in ${language}` : ''
				} so you have word-level timing: a text string plus a words array of { start, end, text, type }.`,
				'3. Call addSubtitles with startTime set to that speech clip\'s timeline start, subtitles.text mapped from the transcript text, and subtitles.words mapped straight from the transcript words with their original timings preserved. Use addSubtitles - do not emulate captions with plain text clips.',
				'4. Style the subtitles for mobile viewing: a heavy sans-serif, high contrast against the footage, a stroke or shadow so it survives bright frames, positioned in the lower third but clear of the platform UI safe area, and short enough that no line wraps awkwardly.',
				'5. Do not call setClipLeftTrim, setClipRightTrim or setTrimDuration on the subtitles clip - subtitle sizing is driven by its content. If the captions are wrong, call addSubtitles again with corrected data instead.',
				'',
				'Report how many caption cues you created and their overall time range.',
				style ? `\nCaption look to aim for: ${style}.` : '',
			].join('\n');
			break;
		}
		case 'createShorts': {
			const count = (options.shortCount as number) ?? 3;
			const minSeconds = (options.minSeconds as number) ?? 20;
			const maxSeconds = (options.maxSeconds as number) ?? 60;
			const ratio = (options.aspectRatio as string) || '9:16';
			prompt = [
				`Find the ${count} strongest short-form moments in this project and build the best one into a finished ${ratio} short.`,
				'',
				'1. Transcribe every speech clip so you can score moments against the actual words and their timings.',
				`2. Score candidate moments on four things: a hook in the first 2 seconds, a self-contained idea that needs no earlier context, a clear payoff or punchline, and a natural place to stop. Each candidate must be between ${minSeconds} and ${maxSeconds} seconds long.`,
				`3. List all ${count} candidates up front with their exact start and end times in seconds and a one-line title for each, ranked best first.`,
				'4. Then build the top-ranked candidate on the timeline: keep only that range (setClipLeftTrim / setClipRightTrim, or removeClipSegments for everything outside it), close the gaps so the short starts at 0.',
				`5. Call reframeClip with ratio "${ratio}" on the video clip so the subject stays in frame and the canvas becomes vertical. Do not use setClipCrop.`,
				'6. Inside the kept range, remove filler words and dead air with removeClipSegments, then add word-level captions with addSubtitles.',
				'',
				'Report every candidate\'s time range in your final message so the remaining shorts can be produced in follow-up runs on the same thread ID.',
			].join('\n');
			break;
		}
		case 'customPrompt':
			prompt = ctx.getNodeParameter('prompt', itemIndex) as string;
			break;
		default:
			throw new NodeOperationError(
				ctx.getNode(),
				`The operation "${operation}" is not supported for resource "edit".`,
				{ itemIndex },
			);
	}

	if (instructions !== '' && operation !== 'customPrompt') {
		prompt = `${prompt}\n\nAdditional instructions from the user: ${instructions}`;
	}
	return prompt;
}

// ---------------------------------------------------------------------------
// Reusable property option lists
// ---------------------------------------------------------------------------

const exportSettingsOptions: INodeProperties[] = [
	{
		displayName: 'Codec',
		name: 'codec',
		type: 'options',
		default: 'h264',
		options: [
			{ name: 'H.264', value: 'h264' },
			{ name: 'VP8', value: 'vp8' },
		],
		description: 'Video codec used for the exported file',
	},
	{
		displayName: 'Quality',
		name: 'quality',
		type: 'options',
		default: 'high',
		options: [
			{ name: 'High', value: 'high' },
			{ name: 'Low', value: 'low' },
			{ name: 'Medium', value: 'medium' },
		],
		description: 'Encoding quality of the exported video',
	},
	{
		displayName: 'Target Resolution',
		name: 'target_resolution',
		type: 'options',
		default: '1080p',
		options: [
			{ name: '1080p', value: '1080p' },
			{ name: '4K', value: '4K' },
			{ name: '720p', value: '720p' },
		],
		description: 'Output resolution of the exported video',
	},
];

const aspectRatioOptions: INodePropertyOptions[] = [
	{ name: '1:1 (Square)', value: '1:1' },
	{ name: '16:9 (Wide)', value: '16:9' },
	{ name: '4:5 (Portrait Feed)', value: '4:5' },
	{ name: '9:16 (Reels, TikTok, Shorts)', value: '9:16' },
];

/** Every resource/operation pair that enqueues an AI job. */
const AI_RESOURCES = ['audio', 'image', 'video'];
const AI_OPERATIONS = [
	'changeVoice',
	'dub',
	'generate',
	'generateMusic',
	'generateSoundEffect',
	'isolateVoice',
	'lipSync',
	'removeBackground',
	'textToSpeech',
	'transcribe',
	'upscale',
];

/**
 * Operations that take a single source media reference. The API accepts the
 * same `params.media` value for all of them: a public URL, a media ID, or the
 * file hash of an upload in the project.
 */
const SINGLE_FILE_OPERATIONS = {
	audio: [] as string[],
	image: ['removeBackground', 'upscale'],
	video: ['changeVoice', 'dub', 'isolateVoice', 'removeBackground', 'transcribe', 'upscale'],
};

const extraParamsProperty: INodeProperties = {
	displayName: 'Additional Parameters (JSON)',
	name: 'extraParams',
	type: 'json',
	// An empty string lints as invalid JSON in the editor; `{}` merges to nothing.
	default: '{}',
	displayOptions: { show: { resource: AI_RESOURCES, operation: AI_OPERATIONS } },
	description:
		'Extra model-specific parameters merged into the request. Call GET /v1/ai/models/{model_id} to see each model\'s schema.',
};

// ---------------------------------------------------------------------------
// Node definition
// ---------------------------------------------------------------------------

export class Rendley implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Rendley',
		name: 'rendley',
		icon: { light: 'file:rendley.svg', dark: 'file:rendley.dark.svg' },
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description:
			'Create, edit, and automate video with Rendley. AI agent edits, AI media generation, projects and MP4 export',
		defaults: {
			name: 'Rendley',
		},
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'rendleyApi',
				required: true,
			},
		],
		properties: [
			// ----- Resource -----
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [
					{ name: 'AI Video Agent', value: 'agent' },
					{ name: 'Audio', value: 'audio' },
					{ name: 'Brand Kit', value: 'brandKit' },
					{ name: 'Edit', value: 'edit' },
					{ name: 'Export', value: 'export' },
					{ name: 'Image', value: 'image' },
					{ name: 'Media', value: 'media' },
					{ name: 'Project', value: 'project' },
					{ name: 'Video', value: 'video' },
				],
				default: 'agent',
			},

			// ----- Agent operations -----
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['agent'] } },
				options: [
					{
						name: 'Cancel Job',
						value: 'cancelJob',
						action: 'Cancel an agent job',
						description: 'Stop an agent job that is still running',
					},
					{
						name: 'Get Job',
						value: 'getJob',
						action: 'Get an agent job',
						description: 'Read an agent job status without waiting, for workflows that poll on their own',
					},
					{
						name: 'Run',
						value: 'run',
						action: 'Run the AI video agent',
						description:
							'Describe the video you want or the edit to make, and the agent creates a project or edits the one you name on a real editing timeline',
					},
				],
				default: 'run',
			},

			// ----- Edit operations -----
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['edit'] } },
				options: [
					{
						name: 'Add Captions',
						value: 'addCaptions',
						action: 'Add captions to a project',
						description: 'Transcribe the speech and burn word-level captions into the timeline',
					},
					{
						name: 'Auto Edit',
						value: 'autoEdit',
						action: 'Auto edit a project',
						description: 'Let the agent cut the raw footage down to a tight, watchable edit',
					},
					{
						name: 'Create Shorts',
						value: 'createShorts',
						action: 'Create shorts from a project',
						description: 'Find the strongest short-form moments and build the best one',
					},
					{
						name: 'Custom Prompt',
						value: 'customPrompt',
						action: 'Run a custom edit prompt',
						description: 'Send your own natural-language editing instructions to the agent',
					},
					{
						name: 'Reframe',
						value: 'reframe',
						action: 'Reframe a project',
						description: 'Re-crop every video clip to a new aspect ratio with subject tracking',
					},
					{
						name: 'Remove Filler Words',
						value: 'removeFillerWords',
						action: 'Remove filler words from a project',
						description: 'Transcribe the speech, then cut fillers, stutters, and dead air',
					},
				],
				default: 'removeFillerWords',
			},

			// ----- Video operations -----
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['video'] } },
				options: [
					{
						name: 'Change Voice',
						value: 'changeVoice',
						action: 'Change the voice in a video',
						description: 'Replace the speaker voice while keeping timing and delivery',
					},
					{
						name: 'Dub',
						value: 'dub',
						action: 'Dub a video into another language',
						description: 'Translate the spoken content and dub it back in the original voice',
					},
					{
						name: 'Generate',
						value: 'generate',
						action: 'Generate a video',
						description: 'Generate a video clip from a text prompt',
					},
					{
						name: 'Isolate Voice',
						value: 'isolateVoice',
						action: 'Isolate the voice in a video',
						description: 'Strip background noise and leave only the clean speech',
					},
					{
						name: 'Lip Sync',
						value: 'lipSync',
						action: 'Lip sync a video',
						description: 'Re-sync the lip movement in a video to a separate audio track',
					},
					{
						name: 'Remove Background',
						value: 'removeBackground',
						action: 'Remove a video background',
						description: 'Cut the subject out of a video frame by frame',
					},
					{
						name: 'Transcribe',
						value: 'transcribe',
						action: 'Transcribe a video',
						description: 'Convert speech to text with word-level timestamps',
					},
					{
						name: 'Upscale',
						value: 'upscale',
						action: 'Upscale a video',
						description: 'Increase video resolution with AI super-resolution, up to 4K',
					},
				],
				default: 'transcribe',
			},

			// ----- Image operations -----
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['image'] } },
				options: [
					{
						name: 'Generate',
						value: 'generate',
						action: 'Generate an image',
						description: 'Generate or edit an image from a text prompt',
					},
					{
						name: 'Remove Background',
						value: 'removeBackground',
						action: 'Remove an image background',
						description: 'Cut the subject out of an image onto transparency',
					},
					{
						name: 'Upscale',
						value: 'upscale',
						action: 'Upscale an image',
						description: 'Increase image resolution with AI super-resolution',
					},
				],
				default: 'generate',
			},

			// ----- Audio operations -----
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['audio'] } },
				options: [
					{
						name: 'Generate Music',
						value: 'generateMusic',
						action: 'Generate music',
						description: 'Generate a music bed from a text prompt',
					},
					{
						name: 'Generate Sound Effect',
						value: 'generateSoundEffect',
						action: 'Generate a sound effect',
						description: 'Generate a short sound effect from a text prompt',
					},
					{
						name: 'Text to Speech',
						value: 'textToSpeech',
						action: 'Generate speech from text',
						description: 'Turn a script into a voiceover with a chosen voice',
					},
				],
				default: 'textToSpeech',
			},

			// ----- Export operations -----
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['export'] } },
				options: [
					{
						name: 'Estimate Cost',
						value: 'estimateCost',
						action: 'Estimate the credit cost of an export',
						description: 'Estimate how many credits an export would consume',
					},
					{
						name: 'Get Job',
						value: 'getJob',
						action: 'Get an export job',
						description: 'Retrieve the status and result of an export job',
					},
					{
						name: 'Export Video',
						value: 'render',
						action: 'Export a project to a video file',
						description: 'Export a project to a video file',
					},
				],
				default: 'render',
			},

			// ----- Media operations -----
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['media'] } },
				options: [
					{
						name: 'Get Download URL',
						value: 'getDownloadUrl',
						action: 'Get a media download URL',
						description: 'Resolve a media ID or file hash to a presigned download URL',
					},
					{
						name: 'Upload',
						value: 'upload',
						action: 'Upload a file to a project',
						description: 'Put a file from a previous node or a URL into the project library',
					},
					{
						name: 'List',
						value: 'list',
						action: 'List project media',
						description: 'List every upload in a project with a fresh download URL',
					},
				],
				default: 'getDownloadUrl',
			},

			// ----- Brand Kit operations -----
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['brandKit'] } },
				options: [
					{
						name: 'Get',
						value: 'get',
						action: 'Get a brand kit',
						description: 'Retrieve the brand kit for a workspace',
					},
					{
						name: 'Import From Website',
						value: 'importFromWebsite',
						action: 'Import a brand kit from a website',
						description: 'Extract colors, fonts, and logos from a public website',
					},
				],
				default: 'get',
			},

			// ----- Project operations -----
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['project'] } },
				options: [
					{
						name: 'Create',
						value: 'create',
						action: 'Create a project',
						description: 'Create a new Rendley project',
					},
					{
						name: 'Delete',
						value: 'delete',
						action: 'Delete a project',
						description: 'Delete a Rendley project',
					},
					{
						name: 'Get',
						value: 'get',
						action: 'Get a project',
						description: 'Retrieve a single Rendley project',
					},
					{
						name: 'List',
						value: 'list',
						action: 'List projects',
						description: 'List Rendley projects',
					},
				],
				default: 'create',
			},

			// ===== AI Video Agent > Run =====
			{
				displayName: 'Prompt',
				name: 'prompt',
				type: 'string',
				required: true,
				typeOptions: { rows: 4 },
				default: '',
				displayOptions: { show: { resource: ['agent'], operation: ['run'] } },
				description: 'What the AI agent should create or change, for example "Cut this interview down to a 30-second teaser with captions"',
			},
			projectLocator(
				{ show: { resource: ['agent'], operation: ['run'] } },
				{
					defaultMode: 'id',
					description:
						'Existing project to edit. Leave empty to let Rendley create a project.',
				},
			),

			// ===== Edit > shared inputs =====
			projectLocator(
				{ show: { resource: ['edit'] } },
				{ required: true, description: 'The project to edit' },
			),
			{
				displayName: 'Prompt',
				name: 'prompt',
				type: 'string',
				required: true,
				typeOptions: { rows: 5 },
				default: '',
				displayOptions: { show: { resource: ['edit'], operation: ['customPrompt'] } },
				description: 'Your own editing instructions, sent to the Rendley agent verbatim',
			},
			{
				displayName: 'Options',
				name: 'editOptions',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				displayOptions: {
					show: {
						resource: ['edit'],
						operation: ['addCaptions', 'autoEdit', 'createShorts', 'reframe', 'removeFillerWords'],
					},
				},
				options: [
					{
						displayName: 'Additional Instructions',
						name: 'extraInstructions',
						type: 'string',
						typeOptions: { rows: 3 },
						default: '',
						description: 'Extra guidance appended to the generated prompt',
					},
					{
						displayName: 'Aspect Ratio',
						name: 'aspectRatio',
						type: 'options',
						default: '9:16',
						options: aspectRatioOptions,
						description: 'Target aspect ratio for reframing',
					},
					{
						displayName: 'Caption Style',
						name: 'captionStyle',
						type: 'string',
						default: '',
						placeholder: 'bold white text with a black stroke, centred lower third',
						description: 'How the captions should look',
					},
					{
						displayName: 'Editorial Style',
						name: 'style',
						type: 'string',
						default: '',
						placeholder: 'punchy social cut',
						description: 'Editorial tone the auto edit should aim for',
					},
					{
						displayName: 'Language',
						name: 'language',
						type: 'string',
						default: '',
						placeholder: 'English',
						description: 'Language the captions should be written in',
					},
					{
						displayName: 'Maximum Length (Seconds)',
						name: 'maxSeconds',
						type: 'number',
						default: 60,
						typeOptions: { minValue: 5 },
						description: 'Longest a generated short may be',
					},
					{
						displayName: 'Minimum Length (Seconds)',
						name: 'minSeconds',
						type: 'number',
						default: 20,
						typeOptions: { minValue: 3 },
						description: 'Shortest a generated short may be',
					},
					{
						displayName: 'Minimum Silence (Seconds)',
						name: 'minSilenceSeconds',
						type: 'number',
						default: 0.6,
						typeOptions: { minValue: 0.1, numberPrecision: 2 },
						description: 'Pauses longer than this are trimmed back to this length',
					},
					{
						displayName: 'Number of Shorts',
						name: 'shortCount',
						type: 'number',
						default: 3,
						typeOptions: { minValue: 1, maxValue: 10 },
						description: 'How many candidate shorts the agent should identify',
					},
					{
						displayName: 'Target Duration (Seconds)',
						name: 'targetDurationSeconds',
						type: 'number',
						default: 60,
						typeOptions: { minValue: 5 },
						description: 'Roughly how long the finished edit should be',
					},
				],
			},

			// ===== Agent + Edit > shared agent plumbing =====
			{
				displayName: 'Files',
				name: 'files',
				type: 'fixedCollection',
				typeOptions: { multipleValues: true },
				default: {},
				placeholder: 'Add File',
				displayOptions: { show: { resource: ['agent', 'edit'] } },
				description: 'Media files to make available to the agent',
				options: [
					{
						name: 'file',
						displayName: 'File',
						values: [
							{
								displayName: 'URL',
								name: 'url',
								type: 'string',
								default: '',
								description: 'Publicly accessible URL of the media file',
							},
							{
								displayName: 'Name',
								name: 'name',
								type: 'string',
								default: '',
								description: 'Optional display name for the file',
							},
						],
					},
				],
			},
			{
				displayName: 'Export Video After Edit',
				name: 'renderAfter',
				type: 'boolean',
				default: false,
				displayOptions: { show: { resource: ['agent', 'edit'] } },
				description: 'Whether to also export a video file after the agent finishes editing',
			},
			{
				displayName: 'Export Settings',
				name: 'renderSettings',
				type: 'collection',
				placeholder: 'Add Setting',
				default: {},
				displayOptions: {
					show: { resource: ['agent', 'edit'], renderAfter: [true] },
				},
				options: exportSettingsOptions,
			},
			{
				displayName: 'Additional Options',
				name: 'additionalOptions',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				displayOptions: { show: { resource: ['agent', 'edit'] } },
				options: [
					{
						displayName: 'Thread ID',
						name: 'threadId',
						type: 'string',
						default: '',
						description:
							'Conversation thread to continue. Requires a Project ID to be set as well.',
					},
				],
			},

			// ===== AI resources > shared inputs =====
			projectLocator(
				{ show: { resource: AI_RESOURCES, operation: AI_OPERATIONS } },
				{
					defaultMode: 'id',
					description:
						'Leave empty to save the result to the workspace library. Set it to save into a project instead.',
				},
			),
			{
				displayName: 'Workspace Name or ID',
				name: 'workspaceId',
				type: 'options',
				typeOptions: { loadOptionsMethod: 'getWorkspacesOrDefault' },
				default: '',
				displayOptions: { show: { resource: AI_RESOURCES, operation: AI_OPERATIONS } },
				description:
					'Workspace whose library receives the result when Project is empty. Leave on Default Workspace to use the first one. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			},
			{
				displayName: 'Model Name or ID',
				name: 'modelId',
				type: 'options',
				typeOptions: {
					loadOptionsMethod: 'getModels',
					loadOptionsDependsOn: ['resource', 'operation'],
				},
				default: '',
				displayOptions: { show: { resource: AI_RESOURCES, operation: AI_OPERATIONS } },
				description:
					'Model to run this action with. Leave on Default to let Rendley pick. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			},

			// ===== AI resources > single source file =====
			{
				displayName: 'File',
				name: 'mediaFile',
				type: 'string',
				required: true,
				default: '',
				displayOptions: {
					show: {
						resource: ['image', 'video'],
						operation: ['changeVoice', 'dub', 'isolateVoice', 'removeBackground', 'transcribe', 'upscale'],
					},
				},
				description:
					'Source media: a public URL, or the media ID or file hash of an upload in this project',
			},

			// ===== Video > Lip Sync =====
			{
				displayName: 'Video File',
				name: 'videoFile',
				type: 'string',
				required: true,
				default: '',
				displayOptions: { show: { resource: ['video'], operation: ['lipSync'] } },
				description:
					'Video to re-sync: a public URL, or the media ID or file hash of an upload in this project',
			},
			{
				displayName: 'Audio File',
				name: 'audioFile',
				type: 'string',
				required: true,
				default: '',
				displayOptions: { show: { resource: ['video'], operation: ['lipSync'] } },
				description:
					'Audio the lips should follow: a public URL, or the media ID or file hash of an upload in this project',
			},

			// ===== Video > Dub =====
			{
				displayName: 'Output Language Name or ID',
				name: 'outputLanguage',
				type: 'options',
				typeOptions: { loadOptionsMethod: 'getTranslateLanguages' },
				required: true,
				default: '',
				displayOptions: { show: { resource: ['video'], operation: ['dub'] } },
				description:
					'Language to dub into. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			},

			// ===== Voice pickers (Change Voice + Text to Speech) =====
			{
				displayName: 'Voice Name or ID',
				name: 'voiceId',
				type: 'options',
				typeOptions: { loadOptionsMethod: 'getVoices' },
				required: true,
				default: '',
				displayOptions: {
					show: { resource: ['audio', 'video'], operation: ['changeVoice', 'textToSpeech'] },
				},
				description:
					'Voice to speak with. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			},

			// ===== Prompt-driven AI operations =====
			{
				displayName: 'Prompt',
				name: 'aiPrompt',
				type: 'string',
				required: true,
				typeOptions: { rows: 4 },
				default: '',
				displayOptions: {
					show: {
						resource: AI_RESOURCES,
						operation: ['generate', 'generateMusic', 'generateSoundEffect', 'textToSpeech'],
					},
				},
				description:
					'Text prompt for the model. For Text to Speech this is the script that gets spoken.',
			},

			// ===== Per-operation option collections =====
			{
				displayName: 'Options',
				name: 'aiOptions',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				displayOptions: { show: { resource: ['video'], operation: ['transcribe'] } },
				options: [
					{
						displayName: 'End Time (Seconds)',
						name: 'end_time',
						type: 'number',
						default: 0,
						typeOptions: { minValue: 0 },
						description: 'Stop transcribing at this offset',
					},
					{
						displayName: 'Start Time (Seconds)',
						name: 'start_time',
						type: 'number',
						default: 0,
						typeOptions: { minValue: 0 },
						description: 'Start transcribing at this offset',
					},
				],
			},
			{
				displayName: 'Options',
				name: 'aiOptions',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				displayOptions: { show: { resource: ['video'], operation: ['dub'] } },
				options: [
					{
						displayName: 'Mode',
						name: 'mode',
						type: 'options',
						default: 'precision',
						options: [
							{ name: 'Precision', value: 'precision' },
							{ name: 'Speed', value: 'speed' },
						],
						description: 'Trade dubbing accuracy against turnaround time',
					},
				],
			},
			{
				displayName: 'Options',
				name: 'aiOptions',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				displayOptions: { show: { resource: ['video'], operation: ['generate'] } },
				options: [
					{
						displayName: 'Aspect Ratio',
						name: 'aspect_ratio',
						type: 'string',
						default: '',
						placeholder: '9:16',
						description: 'Aspect ratio of the generated video, if the model supports it',
					},
					{
						displayName: 'Duration (Seconds)',
						name: 'duration',
						type: 'number',
						default: 6,
						typeOptions: { minValue: 1 },
						description: 'Length of the generated clip, if the model supports it',
					},
					{
						displayName: 'Start Image URL',
						name: 'start_image',
						type: 'string',
						default: '',
						description:
							'Image the generated video should start from. Sent as start_image, which the API maps onto the chosen model\'s first-frame field (e.g. kling-v2.6\'s start_image, veo/seedance\'s image). For models with a different native field (e.g. hailuo-2.3\'s first_frame_image), set it via Additional Parameters instead.',
					},
					{
						displayName: 'Resolution',
						name: 'resolution',
						type: 'string',
						default: '',
						placeholder: '1080p',
						description: 'Output resolution, if the model supports it',
					},
				],
			},
			{
				displayName: 'Options',
				name: 'aiOptions',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				displayOptions: { show: { resource: ['image'], operation: ['generate'] } },
				options: [
					{
						displayName: 'Aspect Ratio',
						name: 'aspect_ratio',
						type: 'string',
						default: '',
						placeholder: '1:1',
						description: 'Aspect ratio of the generated image',
					},
					{
						displayName: 'Reference Image URLs',
						name: 'image_inputs',
						type: 'string',
						default: '',
						description:
							'Comma-separated image URLs to transform or use as reference, for models that accept them',
					},
				],
			},
			{
				displayName: 'Options',
				name: 'aiOptions',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				displayOptions: { show: { resource: ['image'], operation: ['upscale'] } },
				options: [
					{
						displayName: 'Scale',
						name: 'scale',
						type: 'options',
						default: 2,
						options: [
							{ name: '2x', value: 2 },
							{ name: '4x', value: 4 },
						],
						description: 'How much bigger the upscaled image should be',
					},
				],
			},
			{
				displayName: 'Options',
				name: 'aiOptions',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				displayOptions: { show: { resource: ['audio'], operation: ['textToSpeech'] } },
				options: [
					{
						displayName: 'Similarity Boost',
						name: 'similarity_boost',
						type: 'number',
						default: 0.75,
						typeOptions: { minValue: 0, maxValue: 1, numberPrecision: 2 },
						description: 'How closely the output should match the reference voice',
					},
					{
						displayName: 'Speed',
						name: 'speed',
						type: 'number',
						default: 1,
						typeOptions: { minValue: 0.7, maxValue: 1.2, numberPrecision: 2 },
						description: 'Speaking rate, where 1 is the voice default',
					},
					{
						displayName: 'Stability',
						name: 'stability',
						type: 'number',
						default: 0.5,
						typeOptions: { minValue: 0, maxValue: 1, numberPrecision: 2 },
						description: 'Higher values make the delivery more consistent and less expressive',
					},
					{
						displayName: 'Style',
						name: 'style',
						type: 'number',
						default: 0,
						typeOptions: { minValue: 0, maxValue: 1, numberPrecision: 2 },
						description: 'How much stylistic exaggeration to apply',
					},
					{
						displayName: 'Use Speaker Boost',
						name: 'use_speaker_boost',
						type: 'boolean',
						default: false,
						description: 'Whether to sharpen similarity to the reference speaker',
					},
				],
			},
			{
				displayName: 'Options',
				name: 'aiOptions',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				displayOptions: {
					show: { resource: ['audio'], operation: ['generateMusic', 'generateSoundEffect'] },
				},
				options: [
					{
						displayName: 'Duration (Seconds)',
						name: 'duration_seconds',
						type: 'number',
						default: 10,
						typeOptions: { minValue: 0.5, numberPrecision: 1 },
						description: 'Length of the generated audio',
					},
				],
			},
			extraParamsProperty,

			// ===== AI resources > execution controls =====
			{
				displayName: 'Estimate Cost Only',
				name: 'estimateCostOnly',
				type: 'boolean',
				default: false,
				displayOptions: { show: { resource: AI_RESOURCES, operation: AI_OPERATIONS } },
				description:
					'Whether to only estimate the credit cost instead of running the action. Nothing is generated and no credits are spent.',
			},

			// ===== Export > Render / Estimate Cost =====
			projectLocator(
				{ show: { resource: ['export'], operation: ['render', 'estimateCost'] } },
				{ required: true, description: 'The project to export' },
			),
			{
				displayName: 'Export Settings',
				name: 'settings',
				type: 'collection',
				placeholder: 'Add Setting',
				default: {},
				displayOptions: {
					show: { resource: ['export'], operation: ['render', 'estimateCost'] },
				},
				options: exportSettingsOptions,
			},

			// ===== Agent > Get Job / Cancel Job =====
			{
				displayName: 'Job ID',
				name: 'agentJobId',
				type: 'string',
				required: true,
				default: '',
				displayOptions: { show: { resource: ['agent'], operation: ['cancelJob', 'getJob'] } },
				description: 'The agent job to read or cancel',
			},

			// ===== Media > Upload =====
			{
				displayName: 'Source',
				name: 'uploadSource',
				type: 'options',
				options: [
					{
						name: 'Binary Data',
						value: 'binary',
						description: 'A file produced by an earlier node, e.g. Google Drive or an email attachment',
					},
					{
						name: 'URL',
						value: 'url',
						description: 'A publicly reachable file URL',
					},
				],
				default: 'binary',
				displayOptions: { show: { resource: ['media'], operation: ['upload'] } },
				description: 'Where the file comes from',
			},
			{
				displayName: 'Input Binary Field',
				name: 'binaryPropertyName',
				type: 'string',
				required: true,
				default: 'data',
				displayOptions: {
					show: { resource: ['media'], operation: ['upload'], uploadSource: ['binary'] },
				},
				description: 'Name of the binary field holding the file',
			},
			{
				displayName: 'File URL',
				name: 'uploadUrl',
				type: 'string',
				required: true,
				default: '',
				displayOptions: {
					show: { resource: ['media'], operation: ['upload'], uploadSource: ['url'] },
				},
				description: 'Publicly reachable URL of the file to upload',
			},
			{
				displayName: 'File Name',
				name: 'uploadFileName',
				type: 'string',
				default: '',
				displayOptions: { show: { resource: ['media'], operation: ['upload'] } },
				description: 'Name stored in the project library. Defaults to the source file name.',
			},

			// ===== Export > Get Job =====
			{
				displayName: 'Job ID',
				name: 'jobId',
				type: 'string',
				required: true,
				default: '',
				displayOptions: { show: { resource: ['export'], operation: ['getJob'] } },
				description: 'The export job to retrieve',
			},

			// ===== Media =====
			projectLocator(
				{ show: { resource: ['media'] } },
				{ required: true, description: 'Project the media belongs to' },
			),
			{
				displayName: 'Media ID',
				name: 'mediaId',
				type: 'string',
				default: '',
				displayOptions: { show: { resource: ['media'], operation: ['getDownloadUrl'] } },
				description:
					'The media ID returned by an AI job or an upload. Leave empty if you only have the file hash.',
			},
			{
				displayName: 'File Hash',
				name: 'fileHash',
				type: 'string',
				default: '',
				displayOptions: { show: { resource: ['media'], operation: ['getDownloadUrl'] } },
				description:
					'The file_hash returned by an AI job. Used as a fallback when the media ID cannot be resolved.',
			},
			{
				displayName:
					'Rendley download URLs are presigned and expire after about 3 hours. Copy the file to your own storage in the same workflow rather than saving the URL for later.',
				name: 'mediaUrlNotice',
				type: 'notice',
				default: '',
				displayOptions: { show: { resource: ['media'] } },
			},

			// ===== Brand Kit =====
			{
				displayName: 'Workspace Name or ID',
				name: 'brandKitWorkspaceId',
				type: 'options',
				typeOptions: { loadOptionsMethod: 'getWorkspaces' },
				required: true,
				default: '',
				displayOptions: { show: { resource: ['brandKit'] } },
				description:
					'Workspace whose brand kit you want to read or fill. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			},
			{
				displayName: 'Website URL',
				name: 'websiteUrl',
				type: 'string',
				required: true,
				default: '',
				placeholder: 'https://example.com',
				displayOptions: { show: { resource: ['brandKit'], operation: ['importFromWebsite'] } },
				description: 'Public website to extract colors, fonts, and logos from',
			},

			// ===== Project > Create =====
			{
				displayName: 'Name',
				name: 'name',
				type: 'string',
				required: true,
				default: '',
				displayOptions: { show: { resource: ['project'], operation: ['create'] } },
				description: 'Name of the new project',
			},
			{
				displayName: 'Template ID',
				name: 'templateId',
				type: 'string',
				default: '',
				displayOptions: { show: { resource: ['project'], operation: ['create'] } },
				description: 'Optional template to base the project on',
			},

			// ===== Project > Workspace filter (create + list) =====
			{
				displayName: 'Workspace Name or ID',
				name: 'workspaceId',
				type: 'options',
				typeOptions: { loadOptionsMethod: 'getWorkspacesOrDefault' },
				default: '',
				displayOptions: { show: { resource: ['project'], operation: ['create', 'list'] } },
				description:
					'Workspace to scope the project to. Leave on Default Workspace to use the first one. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			},

			// ===== Project > Get / Delete =====
			projectLocator(
				{ show: { resource: ['project'], operation: ['get', 'delete'] } },
				{ required: true, description: 'The project to operate on' },
			),
			{
				displayName: 'Simplify',
				name: 'simplify',
				type: 'boolean',
				default: true,
				displayOptions: { show: { resource: ['project'], operation: ['get'] } },
				description:
					'Whether to return a simplified version of the response instead of the raw data (leaves out the full editor document)',
			},

			// ===== Shared: Wait for Completion =====
			{
				displayName: 'Wait for Completion',
				name: 'waitForCompletion',
				type: 'boolean',
				default: true,
				displayOptions: {
					show: { resource: ['agent', 'export'], operation: ['run', 'render'] },
				},
				description: 'Whether to wait until the job finishes before continuing',
			},
			{
				displayName: 'Wait for Completion',
				name: 'waitForCompletion',
				type: 'boolean',
				default: true,
				displayOptions: { show: { resource: ['edit'] } },
				description: 'Whether to wait until the job finishes before continuing',
			},
			{
				displayName: 'Wait for Completion',
				name: 'waitForCompletion',
				type: 'boolean',
				default: true,
				displayOptions: {
					show: { resource: AI_RESOURCES, operation: AI_OPERATIONS, estimateCostOnly: [false] },
				},
				description:
					'Whether to wait until the job finishes and resolve a download URL for the result',
			},
			{
				displayName: 'Poll Interval (Seconds)',
				name: 'pollInterval',
				type: 'number',
				default: DEFAULT_POLL_INTERVAL_SECONDS,
				typeOptions: { minValue: MIN_POLL_INTERVAL_SECONDS },
				displayOptions: {
					show: {
						resource: ['agent', 'audio', 'edit', 'export', 'image', 'video'],
						waitForCompletion: [true],
					},
				},
				description: 'How often to check whether the job has finished',
			},
			{
				displayName: 'Timeout (Minutes)',
				name: 'pollTimeout',
				type: 'number',
				default: DEFAULT_POLL_TIMEOUT_MINUTES,
				typeOptions: { minValue: 1 },
				displayOptions: {
					show: {
						resource: ['agent', 'audio', 'edit', 'export', 'image', 'video'],
						waitForCompletion: [true],
					},
				},
				description: 'Stop waiting after this long and fail the item',
			},
		],
	};

	methods = {
		listSearch: {
			/** Backs every project resource locator. */
			async searchProjects(
				this: ILoadOptionsFunctions,
				filter?: string,
			): Promise<INodeListSearchResult> {
				const needle = (filter ?? '').toLowerCase();
				const projects = await loadProjectOptions(this);
				return {
					results: projects
						.filter((project) => project.name.toLowerCase().includes(needle))
						.map((project) => ({ name: project.name, value: project.value as string })),
				};
			},
		},

		loadOptions: {
			/** Voices for Text to Speech and Change Voice. */
			async getVoices(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const voices = await rendleyRequest<IDataObject[] | undefined>(
					this,
					'GET',
					'/ai/text-to-speech/voices?limit=100',
				);
				if (!Array.isArray(voices)) {
					return [];
				}
				return voices
					.map((voice) => ({
						name: (voice.name as string) || (voice.id as string),
						value: voice.id as string,
					}))
					.sort((a, b) => a.name.localeCompare(b.name));
			},

			/** Target languages for Dub. */
			async getTranslateLanguages(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const languages = await rendleyRequest<IDataObject[] | undefined>(
					this,
					'GET',
					'/ai/video-translate/languages',
				);
				if (!Array.isArray(languages)) {
					return [];
				}
				return languages
					.map((language) => ({
						name: (language.name as string) || (language.id as string),
						value: language.id as string,
					}))
					.sort((a, b) => a.name.localeCompare(b.name));
			},

			/** Models available for the AI action the node is currently set to. */
			async getModels(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const resource = this.getCurrentNodeParameter('resource') as string;
				const operation = this.getCurrentNodeParameter('operation') as string;
				const action = AI_ACTIONS[`${resource}:${operation}`];
				if (!action) {
					return [];
				}
				const tools = await rendleyRequest<IDataObject[] | undefined>(this, 'GET', '/ai/tools');
				// The catalog spells actions with underscores, the endpoints with hyphens.
				const catalogAction = action.replace(/-/g, '_');
				const tool = tools?.find((entry) => entry.action === catalogAction);
				const models = (tool?.models as IDataObject[] | undefined) ?? [];
				return [
					{ name: 'Default', value: '' },
					...models.map((model) => ({
						name: (model.name as string) || (model.id as string),
						value: model.id as string,
						description: model.description as string | undefined,
					})),
				];
			},

			/** Workspaces, for operations that require one. */
			async getWorkspaces(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				return loadWorkspaceOptions(this);
			},

			/** Workspaces plus the empty choice that falls back to the first one. */
			async getWorkspacesOrDefault(
				this: ILoadOptionsFunctions,
			): Promise<INodePropertyOptions[]> {
				return [
					{ name: 'Default Workspace', value: '' },
					...(await loadWorkspaceOptions(this)),
				];
			},
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		const resource = this.getNodeParameter('resource', 0) as string;
		const operation = this.getNodeParameter('operation', 0) as string;
		const aiAction = AI_ACTIONS[`${resource}:${operation}`];

		for (let i = 0; i < items.length; i++) {
			try {
				let responseData: IDataObject | IDataObject[] = {};

				if ((resource === 'agent' && operation === 'run') || resource === 'edit') {
					// -------------------------------------------------------------
					// AI Video Agent > Run, and every Edit operation, which are
					// curated prompts over the same endpoint.
					// -------------------------------------------------------------
					const prompt =
						resource === 'edit'
							? buildEditPrompt(this, operation, i)
							: (this.getNodeParameter('prompt', i) as string);
					const projectId = this.getNodeParameter('projectId', i, '', {
						extractValue: true,
					}) as string;
					const filesParam = this.getNodeParameter('files', i, {}) as IDataObject;
					const additional = this.getNodeParameter('additionalOptions', i, {}) as IDataObject;
					const waitForCompletion = this.getNodeParameter('waitForCompletion', i, true) as boolean;
					const renderAfter = this.getNodeParameter('renderAfter', i, false) as boolean;
					const intervalMs = pollIntervalMs(this, i);

					const fileEntries = ((filesParam.file as IDataObject[]) || []).filter((entry) => entry.url);

					// Files go through the API's importer first so every upload is
					// complete before the agent starts, then the agent gets them by
					// media ID. That needs a project, so one is created when none is set.
					let agentProjectId = projectId;
					if (fileEntries.length > 0 && !agentProjectId) {
						const workspaceId = await resolveWorkspaceId(this, '');
						const created = await rendleyRequest(this, 'POST', '/projects', {
							name: agentProjectName(prompt),
							workspace_id: workspaceId,
						});
						agentProjectId = created.id as string;
					}
					const files: IDataObject[] = [];
					for (const entry of fileEntries) {
						const url = (entry.url as string).trim();
						const imported = await rendleyRequest(
							this,
							'POST',
							`/projects/${encodeURIComponent(agentProjectId)}/uploads/import`,
							{
								download_url: url,
								file_name: (entry.name as string) || fileNameFromUrl(url),
								role: 'pending',
							},
						);
						files.push({
							media_id: imported.media_id,
							storage_url: imported.storage_url,
							name: imported.original_file_name ?? ((entry.name as string) || fileNameFromUrl(url)),
							file_hash: imported.file_hash,
						});
					}

					const body: IDataObject = { prompt };
					if (agentProjectId) {
						body.project_id = agentProjectId;
					}
					if (additional.threadId) {
						body.thread_id = additional.threadId;
					}
					if (files.length > 0) {
						body.files = files;
					}

					const started = await rendleyRequest(this, 'POST', '/agent', body);
					const jobId = started.job_id as string;
					let projectIdResult = (started.project_id as string) || agentProjectId;
					let status = started.status as string;
					const threadId = (started.thread_id as string | undefined) || undefined;
					let lastMessage: string | undefined;
					let commandsApplied: number | undefined;
					let videoUrl: string | undefined;
					let exportJobId: string | undefined;
					let note: string | undefined;

					// renderAfter always requires the edit to finish first.
					const shouldWait = waitForCompletion || renderAfter;

					if (shouldWait) {
						const job = await pollAgentJob(this, jobId, intervalMs, pollTimeoutMs(this, i));
						status = job.status as string;
						if (job.status !== 'completed') {
							const reason = jobFailureMessage(
								job,
								`The Rendley agent job ${job.status}.`,
							);
							throw new NodeApiError(this.getNode(), { message: reason } as JsonObject, {
								message: reason,
							});
						}
						projectIdResult = (job.project_id as string) || projectIdResult;
						lastMessage = (job.last_message as string | undefined) || undefined;
						commandsApplied = job.commands_applied as number | undefined;
					}

					if (renderAfter && commandsApplied === 0) {
						// Nothing changed on the timeline, so a render would only produce an empty video.
						note = 'The agent made no changes to the project, so nothing was rendered. Its message says why.';
					} else if (renderAfter) {
						if (!projectIdResult) {
							throw new NodeOperationError(
								this.getNode(),
								'Cannot render an MP4: the agent did not return a project ID.',
								{ itemIndex: i },
							);
						}
						const settings = buildSettings(
							this.getNodeParameter('renderSettings', i, {}) as IDataObject,
						);
						const exportBody: IDataObject = { project_id: projectIdResult };
						if (settings) {
							exportBody.settings = settings;
						}
						const exportStarted = await rendleyRequest(this, 'POST', '/export', exportBody);
						exportJobId = exportStarted.job_id as string;
						const exportJob = await pollApiJob(this, exportJobId, intervalMs, pollTimeoutMs(this, i));
						if (exportJob.status !== 'completed') {
							const reason = jobFailureMessage(
								exportJob,
								`The Rendley export ${exportJob.status}.`,
							);
							throw new NodeApiError(this.getNode(), { message: reason } as JsonObject, {
								message: reason,
							});
						}
						videoUrl = exportVideoUrl(exportJob);
					}

					responseData = {
						job_id: jobId,
						project_id: projectIdResult,
						status,
						thread_id: threadId,
						last_message: lastMessage,
					};
					if (resource === 'edit') {
						responseData.operation = operation;
					}
					if (commandsApplied !== undefined) {
						responseData.commands_applied = commandsApplied;
					}
					if (videoUrl) {
						responseData.url = videoUrl;
					}
					if (exportJobId) {
						responseData.export_job_id = exportJobId;
					}
					if (note) {
						responseData.note = note;
					}
				} else if (aiAction !== undefined) {
					// -------------------------------------------------------------
					// Video / Image / Audio. Every AI action shares one shape:
					// POST /ai/{action} { project_id, model_id?, params } -> job id.
					// -------------------------------------------------------------
					const projectId = this.getNodeParameter('projectId', i, '', {
						extractValue: true,
					}) as string;
					const modelId = this.getNodeParameter('modelId', i, '') as string;
					if (modelId) {
						await assertModelMatchesAction(this, aiAction, modelId);
					}
					const options = this.getNodeParameter('aiOptions', i, {}) as IDataObject;
					const estimateCostOnly = this.getNodeParameter(
						'estimateCostOnly',
						i,
						false,
					) as boolean;

					let params: IDataObject = {};

					if (
						SINGLE_FILE_OPERATIONS[resource as keyof typeof SINGLE_FILE_OPERATIONS]?.includes(
							operation,
						)
					) {
						// One field for every kind of reference: the API resolves a URL,
						// a media ID or a file hash itself and probes duration for
						// duration-billed actions.
						setParam(params, 'media', (this.getNodeParameter('mediaFile', i) as string).trim());
					}

					if (resource === 'video' && operation === 'lipSync') {
						setParam(params, 'video_media', (this.getNodeParameter('videoFile', i) as string).trim());
						setParam(params, 'audio_media', (this.getNodeParameter('audioFile', i) as string).trim());
					}
					if (resource === 'video' && operation === 'dub') {
						setParam(
							params,
							'output_language',
							this.getNodeParameter('outputLanguage', i) as string,
						);
					}
					if (
						(resource === 'video' && operation === 'changeVoice') ||
						(resource === 'audio' && operation === 'textToSpeech')
					) {
						setParam(params, 'voice_id', this.getNodeParameter('voiceId', i) as string);
					}
					if (
						['generate', 'generateMusic', 'generateSoundEffect', 'textToSpeech'].includes(operation)
					) {
						setParam(params, 'prompt', this.getNodeParameter('aiPrompt', i) as string);
					}

					for (const [key, value] of Object.entries(options)) {
						if (key === 'image_inputs' && typeof value === 'string') {
							const urls = splitList(value);
							if (urls.length > 0) {
								params.image_inputs = urls;
							}
							continue;
						}
						setParam(params, key, value);
					}

					params = mergeExtraParams(
						this,
						params,
						this.getNodeParameter('extraParams', i, '') as string,
						i,
					);

					// The result lands in the project, or in the workspace library.
					const body: IDataObject = { params };
					if (projectId) {
						body.project_id = projectId;
					} else {
						body.workspace_id = await resolveWorkspaceId(
							this,
							this.getNodeParameter('workspaceId', i, '') as string,
						);
					}
					if (modelId) {
						body.model_id = modelId;
					}

					if (estimateCostOnly) {
						const cost = await rendleyRequest(this, 'POST', `/ai/${aiAction}/cost`, body);
						responseData = {
							action: aiAction,
							credits: typeof cost === 'number' ? cost : (cost as IDataObject)?.credits,
						};
					} else {
						const started = await rendleyRequest(this, 'POST', `/ai/${aiAction}`, body);
						const jobId = extractJobId(this, started, i);
						const waitForCompletion = this.getNodeParameter(
							'waitForCompletion',
							i,
							true,
						) as boolean;

						if (!waitForCompletion) {
							responseData = { action: aiAction, job_id: jobId, status: 'queued' };
						} else {
							const job = await pollApiJob(this, jobId, pollIntervalMs(this, i), pollTimeoutMs(this, i));
							if (job.status !== 'completed') {
								const reason = jobFailureMessage(
									job,
									`The Rendley ${aiAction} job ${job.status}.`,
								);
								throw new NodeApiError(this.getNode(), { message: reason } as JsonObject, {
									message: reason,
								});
							}
							const resultData = parseResultData(job.result_data);
							const output = (job.output ?? undefined) as IDataObject | undefined;
							const mediaId = (output?.media_id ?? resultData?.media_id) as string | undefined;
							const fileHash = (output?.file_hash ?? resultData?.file_hash) as string | undefined;

							// Field names follow the API: the job's `output` fields under
							// their own names, `result_data` parsed, and the raw job.
							responseData = {
								action: aiAction,
								job_id: jobId,
								project_id: projectId || (output?.project_id as string | undefined),
								workspace_id: (body.workspace_id as string | undefined) ?? (output?.workspace_id as string | undefined),
								status: job.status,
								media_id: mediaId,
								file_hash: fileHash,
								mime_type: output?.mime_type,
								size: output?.size,
								duration: output?.duration,
								result_data: resultData,
								job,
							};

							// A completed job carries a freshly signed URL; fall back to the
							// project uploads listing for deployments that do not attach one yet.
							if (output?.url) {
								responseData.url = output.url;
								responseData.url_expires_at = output.url_expires_at;
							} else if (projectId && (mediaId !== undefined || fileHash !== undefined)) {
								const media = await resolveMediaUrl(this, projectId, mediaId, fileHash);
								if (media?.url) {
									responseData.url = media.url;
									responseData.upload = media;
								}
							}
						}
					}
				} else if (resource === 'export' && operation === 'render') {
					// -------------------------------------------------------------
					// Export > Export Video
					// -------------------------------------------------------------
					const projectId = this.getNodeParameter('projectId', i, '', {
						extractValue: true,
					}) as string;
					const settings = buildSettings(this.getNodeParameter('settings', i, {}) as IDataObject);
					const waitForCompletion = this.getNodeParameter('waitForCompletion', i, true) as boolean;

					const body: IDataObject = { project_id: projectId };
					if (settings) {
						body.settings = settings;
					}
					const started = await rendleyRequest(this, 'POST', '/export', body);
					const jobId = started.job_id as string;

					if (waitForCompletion) {
						const job = await pollApiJob(this, jobId, pollIntervalMs(this, i), pollTimeoutMs(this, i));
						if (job.status !== 'completed') {
							const reason = jobFailureMessage(
								job,
								`The Rendley export ${job.status}.`,
							);
							throw new NodeApiError(this.getNode(), { message: reason } as JsonObject, {
								message: reason,
							});
						}
						const resultData = parseResultData(job.result_data);
						responseData = {
							job_id: jobId,
							status: job.status,
							url: exportVideoUrl(job),
							url_expires_at: (job.output as IDataObject | undefined)?.url_expires_at,
							media_id: (job.output as IDataObject | undefined)?.media_id,
							file_hash: (job.output as IDataObject | undefined)?.file_hash,
							mime_type: (job.output as IDataObject | undefined)?.mime_type,
							size: (job.output as IDataObject | undefined)?.size,
							duration: (job.output as IDataObject | undefined)?.duration,
							result_data: resultData,
							job,
						};
					} else {
						responseData = {
							job_id: jobId,
							status: (started.status as string) || 'queued',
						};
					}
				} else if (resource === 'export' && operation === 'estimateCost') {
					// -------------------------------------------------------------
					// Export > Estimate Cost
					// -------------------------------------------------------------
					const projectId = this.getNodeParameter('projectId', i, '', {
						extractValue: true,
					}) as string;
					const settings = buildSettings(this.getNodeParameter('settings', i, {}) as IDataObject);

					const body: IDataObject = { project_id: projectId };
					if (settings) {
						body.settings = settings;
					}
					const cost = await rendleyRequest(this, 'POST', '/export/cost', body);
					responseData = { credits: cost.credits };
				} else if (resource === 'media' && operation === 'upload') {
					// -------------------------------------------------------------
					// Media > Upload
					// -------------------------------------------------------------
					const projectId = this.getNodeParameter('projectId', i, '', {
						extractValue: true,
					}) as string;
					const source = this.getNodeParameter('uploadSource', i, 'binary') as string;
					const chosenName = this.getNodeParameter('uploadFileName', i, '') as string;

					if (source === 'url') {
						// Rendley fetches the file itself, so size is not bounded by n8n's memory.
						const url = (this.getNodeParameter('uploadUrl', i) as string).trim();
						const imported = (await rendleyRequest(
							this,
							'POST',
							`/projects/${encodeURIComponent(projectId)}/uploads/import`,
							{
								download_url: url,
								file_name: chosenName || fileNameFromUrl(url),
								// The editor's hash sync deletes `library` rows the project JSON does not reference.
								role: 'pending',
							},
						)) as IDataObject;
						responseData = {
							media_id: imported.media_id,
							file_hash: imported.file_hash,
							file_name: imported.original_file_name ?? (chosenName || fileNameFromUrl(url)),
							mime_type: imported.mime_type,
							status: imported.status,
							url: imported.storage_url,
							...(imported.duration !== undefined ? { duration: imported.duration } : {}),
						};
					} else {

						const binaryPropertyName = this.getNodeParameter(
							'binaryPropertyName',
							i,
							'data',
						) as string;
						const binary = items[i]?.binary?.[binaryPropertyName];
						if (binary === undefined) {
							const available = Object.keys(items[i]?.binary ?? {});
							throw new NodeOperationError(
								this.getNode(),
								`No binary data in field "${binaryPropertyName}". ${
									available.length > 0
										? `This item carries: ${available.join(', ')}.`
										: 'Connect a node that outputs a file first, for example Google Drive > Download File.'
								}`,
								{ itemIndex: i },
							);
						}
						const bytes = await this.helpers.getBinaryDataBuffer(i, binaryPropertyName);
						const fileName = chosenName || binary?.fileName || 'upload';
						const mimeType = binary?.mimeType || 'application/octet-stream';
						responseData = await uploadBytes(this, projectId, bytes, fileName, mimeType, i);
					}
				} else if (resource === 'agent' && operation === 'getJob') {
					// -------------------------------------------------------------
					// Agent > Get Job
					// -------------------------------------------------------------
					const agentJobId = this.getNodeParameter('agentJobId', i) as string;
					responseData = (await rendleyRequest(
						this,
						'GET',
						`/agent/jobs/${encodeURIComponent(agentJobId)}`,
					)) as IDataObject;
				} else if (resource === 'agent' && operation === 'cancelJob') {
					// -------------------------------------------------------------
					// Agent > Cancel Job
					// -------------------------------------------------------------
					const agentJobId = this.getNodeParameter('agentJobId', i) as string;
					responseData = (await rendleyRequest(
						this,
						'POST',
						`/agent/jobs/${encodeURIComponent(agentJobId)}/cancel`,
					)) as IDataObject;
				} else if (resource === 'export' && operation === 'getJob') {
					// -------------------------------------------------------------
					// Export > Get Job
					// -------------------------------------------------------------
					const jobId = this.getNodeParameter('jobId', i) as string;
					const job = (await rendleyRequest(this, 'GET', `/jobs/${jobId}`)) as IDataObject;
					const resultData = parseResultData(job.result_data);
					responseData = { ...job, result_data: resultData };
				} else if (resource === 'media' && operation === 'getDownloadUrl') {
					// -------------------------------------------------------------
					// Media > Get Download URL
					// -------------------------------------------------------------
					const projectId = this.getNodeParameter('projectId', i, '', {
						extractValue: true,
					}) as string;
					const mediaId = (this.getNodeParameter('mediaId', i, '') as string).trim();
					const fileHash = (this.getNodeParameter('fileHash', i, '') as string).trim();

					if (mediaId === '' && fileHash === '') {
						throw new NodeOperationError(
							this.getNode(),
							'Set either a Media ID or a File Hash so Rendley knows which file to resolve.',
							{ itemIndex: i },
						);
					}

					const media = await resolveMediaUrl(
						this,
						projectId,
						mediaId === '' ? undefined : mediaId,
						fileHash === '' ? undefined : fileHash,
					);
					if (media === undefined) {
						throw new NodeOperationError(
							this.getNode(),
							`No media found in project "${projectId}" for ${
								mediaId !== '' ? `media ID "${mediaId}"` : `file hash "${fileHash}"`
							}.`,
							{ itemIndex: i },
						);
					}
					responseData = { project_id: projectId, ...media };
				} else if (resource === 'media' && operation === 'list') {
					// -------------------------------------------------------------
					// Media > List
					// -------------------------------------------------------------
					const projectId = this.getNodeParameter('projectId', i, '', {
						extractValue: true,
					}) as string;
					const uploads = await rendleyRequest<IDataObject[] | undefined>(
						this,
						'GET',
						`/projects/${encodeURIComponent(projectId)}/uploads`,
					);
					responseData = (uploads || []).map((upload) => ({
						...upload,
						url: upload.storage_url,
					}));
				} else if (resource === 'brandKit' && operation === 'get') {
					// -------------------------------------------------------------
					// Brand Kit > Get
					// -------------------------------------------------------------
					const workspaceId = this.getNodeParameter('brandKitWorkspaceId', i) as string;
					responseData = (await rendleyRequest(
						this,
						'GET',
						`/brandkit/${encodeURIComponent(workspaceId)}`,
					)) as IDataObject;
				} else if (resource === 'brandKit' && operation === 'importFromWebsite') {
					// -------------------------------------------------------------
					// Brand Kit > Import From Website
					// -------------------------------------------------------------
					const workspaceId = this.getNodeParameter('brandKitWorkspaceId', i) as string;
					const websiteUrl = this.getNodeParameter('websiteUrl', i) as string;
					responseData = (await rendleyRequest(
						this,
						'POST',
						`/brandkit/${encodeURIComponent(workspaceId)}/import`,
						{ website_url: websiteUrl },
					)) as IDataObject;
				} else if (resource === 'project' && operation === 'create') {
					// -------------------------------------------------------------
					// Project > Create
					// -------------------------------------------------------------
					const name = this.getNodeParameter('name', i) as string;
					const workspaceId = await resolveWorkspaceId(
						this,
						this.getNodeParameter('workspaceId', i, '') as string,
					);
					const templateId = this.getNodeParameter('templateId', i, '') as string;

					const body: IDataObject = { name, workspace_id: workspaceId };
					if (templateId) {
						body.template_id = templateId;
					}
					responseData = (await rendleyRequest(
						this,
						'POST',
						'/projects',
						body,
					)) as IDataObject;
				} else if (resource === 'project' && operation === 'get') {
					// -------------------------------------------------------------
					// Project > Get
					// -------------------------------------------------------------
					const projectId = this.getNodeParameter('projectId', i, '', {
						extractValue: true,
					}) as string;
					const project = (await rendleyRequest(
						this,
						'GET',
						`/projects/${encodeURIComponent(projectId)}`,
					)) as IDataObject;
					if (this.getNodeParameter('simplify', i, true) as boolean) {
						// project_json is the full editor document, often hundreds of KB.
						delete project.project_json;
					}
					responseData = project;
				} else if (resource === 'project' && operation === 'list') {
					// -------------------------------------------------------------
					// Project > List
					// -------------------------------------------------------------
					const workspaceId = await resolveWorkspaceId(
						this,
						this.getNodeParameter('workspaceId', i, '') as string,
					);
					const projects = await rendleyRequest<IDataObject[] | undefined>(
						this,
						'GET',
						`/projects?workspace_id=${encodeURIComponent(workspaceId)}`,
					);
					responseData = projects || [];
				} else if (resource === 'project' && operation === 'delete') {
					// -------------------------------------------------------------
					// Project > Delete
					// -------------------------------------------------------------
					const projectId = this.getNodeParameter('projectId', i, '', {
						extractValue: true,
					}) as string;
					await rendleyRequest(this, 'DELETE', `/projects/${encodeURIComponent(projectId)}`);
					responseData = { deleted: true, id: projectId };
				} else {
					throw new NodeOperationError(
						this.getNode(),
						`The operation "${operation}" is not supported for resource "${resource}".`,
						{ itemIndex: i },
					);
				}

				if (Array.isArray(responseData)) {
					for (const entry of responseData) {
						returnData.push({ json: entry, pairedItem: { item: i } });
					}
				} else {
					returnData.push({ json: responseData, pairedItem: { item: i } });
				}
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({
						json: { error: (error as Error).message },
						pairedItem: { item: i },
					});
					continue;
				}
				throw asNodeError(this, error);
			}
		}

		return [returnData];
	}
}
