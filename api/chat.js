// Blumiin — Quick Guidance chatbot (Vercel serverless function).
// Proxies to Groq server-side; the browser never sees the API key.
// Set GROQ_API_KEY (and optionally GROQ_MODEL) in Vercel env vars.

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'chat_unavailable' });

  try {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { body = {}; } }
    body = body || {};

    // Sanitize the conversation: only user/assistant turns, capped, trimmed.
    const incoming = Array.isArray(body.messages) ? body.messages : [];
    const history = incoming
      .filter(function (m) { return m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string'; })
      .slice(-12)
      .map(function (m) { return { role: m.role, content: m.content.slice(0, 1500) }; });

    if (!history.length || history[history.length - 1].role !== 'user') {
      return res.status(400).json({ error: 'no_user_message' });
    }

    const context = (body.context || '').toString().slice(0, 800);

    const system =
      "You are Blumiin's Quick Guidance assistant — a warm, friendly AI guide that helps people " +
      'explore herbal wellness. You are NOT a doctor and you make that clear when it matters. ' +
      'Give concise, plain-language guidance (aim for 2-4 short paragraphs, no walls of text). ' +
      'Ground suggestions in how Blumiin frames evidence: Strong (clinical), Emerging (preliminary), ' +
      'or Traditional use — and be honest about which one applies. ' +
      'Never diagnose. Never tell someone to start, stop, or change a prescription medication. ' +
      'Whenever medications, pregnancy, or significant or worsening symptoms come up, clearly recommend ' +
      'consulting a healthcare professional, and remind them Blumiin can connect them with a verified expert. ' +
      'If asked about something outside herbal wellness, gently steer back. ' +
      'Be encouraging but never make promises of cures.' +
      (context ? '\n\nWhat we already know about this person from their assessment:\n' + context : '');

    const messages = [{ role: 'system', content: system }].concat(history);

    const controller = new AbortController();
    const timer = setTimeout(function () { controller.abort(); }, 15000);

    const groqRes = await fetch(GROQ_URL, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.6,
        max_tokens: 500,
        messages: messages
      }),
      signal: controller.signal
    });
    clearTimeout(timer);

    if (!groqRes.ok) {
      const detail = await groqRes.text().catch(function () { return ''; });
      console.error('Groq chat error', groqRes.status, detail.slice(0, 300));
      return res.status(502).json({ error: 'upstream_error' });
    }

    const data = await groqRes.json();
    const reply = data && data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content : '';

    if (!reply) return res.status(502).json({ error: 'empty_reply' });

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ reply: String(reply).slice(0, 2000) });
  } catch (err) {
    console.error('chat handler error', err && err.message);
    return res.status(502).json({ error: 'server_error' });
  }
}
