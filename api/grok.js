const RATE_LIMIT = new Map();
const RATE_LIMIT_WINDOW = 60000;
const MAX_REQUESTS = 20;

function checkRateLimit(ip) {
  const now = Date.now();
  const requests = (RATE_LIMIT.get(ip) || []).filter(t => now - t < RATE_LIMIT_WINDOW);
  if (requests.length >= MAX_REQUESTS) return false;
  requests.push(now);
  RATE_LIMIT.set(ip, requests);
  return true;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // ✅ Read key inside handler
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    console.error('GROQ_API_KEY is not set');
    return res.status(500).json({ error: 'GROQ_API_KEY not configured' });
  }

  const ip = req.headers['x-forwarded-for'] || 'unknown';
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Too many requests. Try again later.' });
  }

  const { messages, systemPrompt, topic, mode } = req.body || {};

  // ── MCQ generation mode (called by questionService.ts) ──
  if (topic || mode === 'mcq') {
    const selectedTopic = topic || 'Indian History';
    const prompt = `Generate exactly 10 multiple choice questions for UPSC Civil Services exam on the topic: "${selectedTopic}".

Return ONLY a valid JSON array. Start directly with [ and end with ]. No text before or after.
Each object must have exactly these fields:
{
  "questionNumber": 1,
  "question": "question text",
  "options": { "A": "option", "B": "option", "C": "option", "D": "option" },
  "correctAnswer": "A",
  "explanation": "brief explanation",
  "topic": "${selectedTopic}"
}`;

    try {
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 4096,
          temperature: 0.7,
        }),
      });

      const d = await r.json();
      const text = d?.choices?.[0]?.message?.content || '';
      const clean = text.replace(/```json|```/g, '').trim();
      const s = clean.indexOf('[');
      const e = clean.lastIndexOf(']');
      if (s === -1 || e === -1) {
        return res.status(502).json({ error: 'Invalid response from Groq' });
      }
      const questions = JSON.parse(clean.slice(s, e + 1));
      return res.status(200).json({ questions, topic: selectedTopic, source: 'groq' });
    } catch (e) {
      console.error('Groq MCQ error:', e.message);
      return res.status(500).json({ error: e.message });
    }
  }

  // ── Chat mode (called by groqService.ts / AskAIScreen) ──
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array is required for chat mode' });
  }

  try {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [
          ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
          ...messages,
        ],
        max_tokens: 1024,
        temperature: 0.7,
      }),
    });

    const d = await r.json();
    if (!r.ok) {
      console.error('Groq chat error:', r.status, JSON.stringify(d));
      return res.status(502).json({ error: d?.error?.message || 'Groq API error' });
    }

    const reply = d?.choices?.[0]?.message?.content || '';
    return res.status(200).json({ reply });
  } catch (e) {
    console.error('Groq chat error:', e.message);
    return res.status(500).json({ error: e.message });
  }
}