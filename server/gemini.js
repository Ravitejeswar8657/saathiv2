// server/gemini.js
// Thin wrapper around the Gemini REST API for extracting + classifying constituent
// grievances, whatever channel they arrive through: photographed walk-in forms (OCR),
// typed phone-call summaries, and dictated / voice-note audio. Lazy-imported from
// server/index.js so a missing GEMINI_API_KEY never crashes the server — only the
// specific request fails.

// 'latest' alias so this keeps working as Google retires dated model versions.
const MODEL = 'gemini-flash-latest';

const DEFAULT_TIMEOUT_MS = 30000;
// Voice notes and dictated summaries run much longer than a form photo, and Gemini
// transcribes before it classifies — 30s is not enough headroom for a 3-minute clip.
const AUDIO_TIMEOUT_MS = 45000;

function endpoint(apiKey) {
  return `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`;
}

// Shared request/timeout/parse path for every call in this module.
async function callGemini(parts, responseSchema, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');

  const body = {
    contents: [{ parts }],
    generationConfig: { responseMimeType: 'application/json', responseSchema },
  };

  const resp = await fetch(endpoint(apiKey), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    throw new Error(`Gemini HTTP ${resp.status}: ${detail.slice(0, 300)}`);
  }

  const data = await resp.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini returned no content (response may have been blocked)');

  return JSON.parse(text);
}

function categoryLines(categories) {
  return categories.map(c => `- ${c.key}: ${c.label}`).join('\n');
}

// Shared tail of every prompt: how to pick a category and judge urgency.
function triageInstructions(categories) {
  return `For "category", pick the single best match from this fixed list (default to "others" if nothing fits well):
${categoryLines(categories)}

For "urgency", judge how time-sensitive the issue sounds (e.g. active medical emergency, imminent deadline, or distress language = High; a routine follow-up or general request = Low). Give a one-phrase "urgency_reason" citing the specific signal you used.`;
}

function buildImagePrompt(categories) {
  return `You are reading a photographed handwritten Indian government "Visitor Information" form used by an MP's constituency office. The form has sections: Visitor Information (full name, address, village, mandal, assembly constituency, reference name, contact number, email, date of visit, reference number), an Issue Description, and Action Details (action taken, action to be taken, assigned officer, resolution status, deadline).

Extract only what is legibly written on the form. If a field is illegible, crossed out, or not filled in, return an empty string for it — never invent or guess a value.

${triageInstructions(categories)}

For "ocr_confidence", rate how legible/certain your overall reading of the handwriting was.

date_of_visit should be normalized to YYYY-MM-DD if a date is written and unambiguous; otherwise return your best-effort raw reading of what's written.`;
}

function buildTextPrompt(categories) {
  return `You are triaging a grievance reported to an Indian MP's constituency office by phone call or WhatsApp message, written up as free text by office staff or sent by the constituent themselves. The text may be in English, Telugu, or a mix.

Pull out whatever details are actually present (name, village, mandal, contact number, and so on). Most of these fields will be missing — return an empty string for anything not stated. Never invent or guess a value. Write "issue_description" as a clear one-or-two-sentence summary of what the person is asking for.

${triageInstructions(categories)}

Set "is_grievance" to false when the message is not a request for help at all — a greeting, a thank-you note, spam, a wrong number, or general chit-chat. Set it to true only when there is an actual issue or request the office could act on.

Set "confidence" to how certain you are of that is_grievance judgement and the category you picked. Use Low when the message is too short or vague to tell.

date_of_visit should be YYYY-MM-DD if the text states when the issue was reported or occurred; otherwise return an empty string.`;
}

function buildAudioPrompt(categories) {
  return `You are processing an audio recording of a grievance reported to an Indian MP's constituency office — either a constituent's voice note or an office staff member dictating a summary of a phone call or desk visit.

First transcribe the audio into "transcript". The speaker may use Telugu, English, or a mix of both. Keep the original language and script — transcribe Telugu speech in Telugu script. Do not translate. If parts are inaudible, mark them [inaudible] rather than guessing.

Then extract the grievance fields from that transcript. Return an empty string for any detail not actually spoken — never invent or guess a value. Write "issue_description" as a clear one-or-two-sentence summary of what the person is asking for.

${triageInstructions(categories)}

Set "is_grievance" to false when the recording is not a request for help at all — a greeting, a test recording, or unrelated chatter. Set it to true only when there is an actual issue or request the office could act on.

Set "confidence" to how certain you are of that is_grievance judgement and the category you picked. Use Low when the audio is unclear or too short to tell.

date_of_visit should be YYYY-MM-DD if the speaker states when the issue was reported or occurred; otherwise return an empty string.`;
}

// Fields shared by every extraction path. `category` is added per-call because its
// enum is built from the caller's live category list.
const SHARED_PROPERTIES = {
  full_name: { type: 'STRING' },
  address: { type: 'STRING' },
  village: { type: 'STRING' },
  mandal: { type: 'STRING' },
  assembly_constituency: { type: 'STRING' },
  reference_name: { type: 'STRING' },
  reference_number: { type: 'STRING' },
  contact_number: { type: 'STRING' },
  email: { type: 'STRING' },
  date_of_visit: { type: 'STRING' },
  issue_description: { type: 'STRING' },
  action_taken: { type: 'STRING' },
  action_to_be_taken: { type: 'STRING' },
  assigned_officer: { type: 'STRING' },
  resolution_status: { type: 'STRING', enum: ['Pending', 'In Progress', 'Resolved'] },
  deadline: { type: 'STRING' },
  urgency: { type: 'STRING', enum: ['High', 'Medium', 'Low'] },
  urgency_reason: { type: 'STRING' },
};

// Walk-in forms carry a name and a legibility rating; phone/WhatsApp intake carries
// neither, but does need the is_grievance triage gate the inbox reviews against.
const IMAGE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    ...SHARED_PROPERTIES,
    ocr_confidence: { type: 'STRING', enum: ['High', 'Medium', 'Low'] },
  },
  required: ['full_name', 'issue_description', 'category', 'urgency'],
};

const TEXT_SCHEMA = {
  type: 'OBJECT',
  properties: {
    ...SHARED_PROPERTIES,
    is_grievance: { type: 'BOOLEAN' },
    confidence: { type: 'STRING', enum: ['High', 'Medium', 'Low'] },
  },
  required: ['issue_description', 'category', 'urgency', 'is_grievance', 'confidence'],
};

const AUDIO_SCHEMA = {
  type: 'OBJECT',
  properties: {
    ...TEXT_SCHEMA.properties,
    transcript: { type: 'STRING' },
  },
  required: [...TEXT_SCHEMA.required, 'transcript'],
};

function withCategoryEnum(schema, categories) {
  return {
    ...schema,
    properties: {
      ...schema.properties,
      category: { type: 'STRING', enum: categories.map(c => c.key) },
    },
  };
}

export async function extractGrievanceFromImage(buffer, mimeType, categories) {
  return callGemini(
    [
      { text: buildImagePrompt(categories) },
      { inline_data: { mime_type: mimeType, data: buffer.toString('base64') } },
    ],
    withCategoryEnum(IMAGE_SCHEMA, categories),
  );
}

export async function extractGrievanceFromText(text, categories) {
  return callGemini(
    [{ text: `${buildTextPrompt(categories)}\n\n--- Reported grievance ---\n${text}` }],
    withCategoryEnum(TEXT_SCHEMA, categories),
  );
}

export async function extractGrievanceFromAudio(buffer, mimeType, categories) {
  return callGemini(
    [
      { text: buildAudioPrompt(categories) },
      { inline_data: { mime_type: mimeType, data: buffer.toString('base64') } },
    ],
    withCategoryEnum(AUDIO_SCHEMA, categories),
    AUDIO_TIMEOUT_MS,
  );
}

const SUGGESTION_SCHEMA = {
  type: 'OBJECT',
  properties: {
    suggested_response: { type: 'STRING' },
    suggested_next_action: { type: 'STRING' },
  },
  required: ['suggested_response', 'suggested_next_action'],
};

// Advisory only — this drafts text for staff to review and edit, never something
// sent or acted on automatically.
export async function suggestGrievanceResponse(grievance) {
  const prompt = `You are drafting a response for an Indian MP's constituency office to a citizen's grievance. Be concise, respectful, and specific — no generic platitudes.

Category: ${grievance.category || 'others'}
Urgency: ${grievance.urgency || 'Medium'}
Issue: ${grievance.issue_description || '(no description)'}

Write two things:
1. "suggested_response" — a short, warm 2-3 sentence reply to read or send back to the citizen, acknowledging the issue and what happens next. Do not invent a specific date or officer name unless one was given.
2. "suggested_next_action" — a short internal next step for office staff (e.g. which department to forward it to, what to verify, a follow-up window).`;

  return callGemini([{ text: prompt }], SUGGESTION_SCHEMA);
}

const LETTER_SCHEMA = {
  type: 'OBJECT',
  properties: {
    subject: { type: 'STRING' },
    body: { type: 'STRING' },
  },
  required: ['subject', 'body'],
};

// Advisory only — drafts a formal letter for staff to review and edit before it's
// ever printed or sent; never wired into the save/commit path itself.
export async function draftDepartmentLetter(grievance, departmentInfo, mpName) {
  const prompt = `You are drafting a formal letter from an Indian Member of Parliament's office to a
government department head, requesting action on a constituent's grievance. Formal, respectful register.

Recipient: ${departmentInfo.department_head}, ${departmentInfo.department}
From: ${mpName || 'Member of Parliament'}
Constituent: ${grievance.full_name || '(name not given)'}, ${[grievance.village, grievance.mandal].filter(Boolean).join(', ') || '(location not given)'}
Contact: ${grievance.contact_number || 'not given'}
Category: ${grievance.category || 'others'}
Urgency: ${grievance.urgency || 'Medium'}
Issue: ${grievance.issue_description || '(no description)'}

Write two things:
1. "subject" — a single-line formal subject (no "Sub:" prefix — that's added separately), specific to this issue.
2. "body" — 2-4 formal paragraphs: state the issue, request specific action/inquiry, close requesting a
status update within a reasonable window. Do not invent facts (dates, officer names, reference numbers)
not present above.`;

  return callGemini([{ text: prompt }], LETTER_SCHEMA);
}
