// server/gemini.js
// Thin wrapper around the Gemini REST API for OCR + classification of photographed
// MP-office visitor grievance forms. Lazy-imported from server/index.js so a missing
// GEMINI_API_KEY never crashes the server — only the specific request fails.

// 'latest' alias so this keeps working as Google retires dated model versions.
const MODEL = 'gemini-flash-latest';

function endpoint(apiKey) {
  return `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`;
}

function buildPrompt(categories) {
  const categoryList = categories.map(c => `- ${c.key}: ${c.label}`).join('\n');
  return `You are reading a photographed handwritten Indian government "Visitor Information" form used by an MP's constituency office. The form has sections: Visitor Information (full name, address, village, mandal, assembly constituency, reference name, contact number, email, date of visit, reference number), an Issue Description, and Action Details (action taken, action to be taken, assigned officer, resolution status, deadline).

Extract only what is legibly written on the form. If a field is illegible, crossed out, or not filled in, return an empty string for it — never invent or guess a value.

For "category", pick the single best match from this fixed list based on the issue description (default to "others" if nothing fits well):
${categoryList}

For "urgency", judge how time-sensitive the visitor's issue sounds from the issue description text (e.g. active medical emergency, imminent deadline, or distress language = High; a routine follow-up or general request = Low). Give a one-phrase "urgency_reason" citing the specific textual signal you used.

For "ocr_confidence", rate how legible/certain your overall reading of the handwriting was.

date_of_visit should be normalized to YYYY-MM-DD if a date is written and unambiguous; otherwise return your best-effort raw reading of what's written.`;
}

const RESPONSE_SCHEMA_BASE = {
  type: 'OBJECT',
  properties: {
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
    ocr_confidence: { type: 'STRING', enum: ['High', 'Medium', 'Low'] },
  },
  required: ['full_name', 'issue_description', 'category', 'urgency'],
};

export async function extractVisitorForm(buffer, mimeType, categories) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');

  const responseSchema = {
    ...RESPONSE_SCHEMA_BASE,
    properties: {
      ...RESPONSE_SCHEMA_BASE.properties,
      category: { type: 'STRING', enum: categories.map(c => c.key) },
    },
  };

  const body = {
    contents: [{
      parts: [
        { text: buildPrompt(categories) },
        { inline_data: { mime_type: mimeType, data: buffer.toString('base64') } },
      ],
    }],
    generationConfig: { responseMimeType: 'application/json', responseSchema },
  };

  const resp = await fetch(endpoint(apiKey), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
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
