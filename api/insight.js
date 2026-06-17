// Blumiin — serverless insight engine (Vercel function).
// Holds the Groq API key server-side. The browser NEVER sees the key.
// Set GROQ_API_KEY (and optionally GROQ_MODEL) in Vercel → Project → Settings → Environment Variables.

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    // No key configured — tell the client to use its local fallback.
    return res.status(503).json({ error: 'insight_unavailable' });
  }

  try {
    // Vercel parses JSON bodies automatically, but guard for string bodies too.
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { body = {}; } }
    body = body || {};

    const answers = body.answers || {};
    const message = (body.message || '').toString().slice(0, 1200);
    const herbs = Array.isArray(body.herbs) ? body.herbs.slice(0, 5) : [];

    const system =
      'You are Blumiin\'s wellness insight assistant. Blumiin helps people explore herbal remedies ' +
      'with evidence, tradition, and community context — and prioritizes safety. ' +
      'You write warm, plain-language, NON-prescriptive guidance. You never promise cures, never ' +
      'tell someone to stop a medication, and you encourage professional consultation when medications ' +
      'or significant symptoms are involved. ' +
      'Return ONLY a JSON object with exactly these keys: ' +
      '"profileNarrative" (2-3 sentence empathetic summary of the user\'s situation, second person), ' +
      '"secondaryConcern" (2-4 word phrase naming a likely secondary concern inferred from their answers/message), ' +
      '"personalizedNote" (one sentence of safety-aware encouragement tailored to whether they take medication), ' +
      '"herbNotes" (an object mapping each provided herb name to ONE short personalized sentence on why it fits them). ' +
      'Do not include markdown, code fences, or any text outside the JSON.';

    const user =
      'User assessment:\n' +
      '- Primary goal: ' + (answers.goal || 'n/a') + '\n' +
      '- Severity: ' + (answers.severity || 'n/a') + '\n' +
      '- Duration: ' + (answers.duration || 'n/a') + '\n' +
      '- Preferred approach: ' + (answers.approach || 'n/a') + '\n' +
      '- Experience level: ' + (answers.experience || 'n/a') + '\n' +
      '- Taking medications: ' + (answers.medications || 'n/a') + '\n' +
      '- In their words: ' + (message ? '"' + message + '"' : '(none provided)') + '\n\n' +
      'Recommended herbs to write herbNotes for: ' + (herbs.length ? herbs.join(', ') : '(none)') + '\n\n' +
      'Respond with the JSON object now.';

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);

    const groqRes = await fetch(GROQ_URL, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.55,
        max_tokens: 700,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user }
        ]
      }),
      signal: controller.signal
    });
    clearTimeout(timer);

    if (!groqRes.ok) {
      const detail = await groqRes.text().catch(() => '');
      console.error('Groq error', groqRes.status, detail.slice(0, 300));
      return res.status(502).json({ error: 'upstream_error' });
    }

    const data = await groqRes.json();
    const content = data && data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content : '';

    let parsed;
    try { parsed = JSON.parse(content); }
    catch (_) {
      const m = content.match(/\{[\s\S]*\}/);
      parsed = m ? JSON.parse(m[0]) : null;
    }
    if (!parsed || !parsed.profileNarrative) {
      return res.status(502).json({ error: 'parse_error' });
    }

    // Sanitize / normalize
    const clean = {
      profileNarrative: String(parsed.profileNarrative).slice(0, 700),
      secondaryConcern: parsed.secondaryConcern ? String(parsed.secondaryConcern).slice(0, 60) : '',
      personalizedNote: parsed.personalizedNote ? String(parsed.personalizedNote).slice(0, 360) : '',
      herbNotes: {}
    };
    if (parsed.herbNotes && typeof parsed.herbNotes === 'object') {
      herbs.forEach(function (name) {
        if (parsed.herbNotes[name]) clean.herbNotes[name] = String(parsed.herbNotes[name]).slice(0, 240);
      });
    }

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json(clean);
  } catch (err) {
    console.error('insight handler error', err && err.message);
    return res.status(502).json({ error: 'server_error' });
  }
}
