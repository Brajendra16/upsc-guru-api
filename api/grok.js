// ── Rate limiting (per IP, server-side) ──────────────────────────────────────
const RATE_LIMIT = new Map();
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const MAX_REQUESTS_PER_MIN = 20;

function checkRateLimit(ip) {
  const now = Date.now();
  const requests = (RATE_LIMIT.get(ip) || []).filter(t => now - t < RATE_LIMIT_WINDOW);
  if (requests.length >= MAX_REQUESTS_PER_MIN) return false;
  requests.push(now);
  RATE_LIMIT.set(ip, requests);
  return true;
}

// ── Per-user daily message limit ─────────────────────────────────────────────
const USER_DAILY = new Map(); // userId → { date, count }
const MAX_DAILY_MESSAGES = 20;

function checkUserDailyLimit(userId) {
  if (!userId) return true; // no userId = skip limit (MCQ mode)
  const today = new Date().toISOString().split('T')[0];
  const entry = USER_DAILY.get(userId);
  if (!entry || entry.date !== today) {
    USER_DAILY.set(userId, { date: today, count: 1 });
    return true;
  }
  if (entry.count >= MAX_DAILY_MESSAGES) return false;
  entry.count += 1;
  return true;
}

// ── UPSC system prompt for chat mode ─────────────────────────────────────────
const UPSC_SYSTEM_PROMPT = `You are an expert UPSC Civil Services exam assistant for Indian students. 
Answer clearly and concisely, focused on the Indian context.
Use bullet points where helpful. Keep answers under 300 words.
For factual questions, be precise. For strategy questions, be practical.`;

// ── Provider: Groq ────────────────────────────────────────────────────────────
async function callGroq(messages, systemPrompt) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('GROQ_API_KEY not set');

  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: systemPrompt || UPSC_SYSTEM_PROMPT },
        ...messages,
      ],
      max_tokens: 1024,
      temperature: 0.7,
    }),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(`Groq ${r.status}: ${d?.error?.message || 'failed'}`);
  const reply = d?.choices?.[0]?.message?.content;
  if (!reply) throw new Error('Groq returned empty response');
  return reply;
}

// ── Provider: Mistral ─────────────────────────────────────────────────────────
async function callMistral(messages, systemPrompt) {
  const apiKey = process.env.MISTRAL_API_KEY;
  if (!apiKey) throw new Error('MISTRAL_API_KEY not set');

  const r = await fetch('https://api.mistral.ai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: 'mistral-small-latest',
      messages: [
        { role: 'system', content: systemPrompt || UPSC_SYSTEM_PROMPT },
        ...messages,
      ],
      max_tokens: 1024,
      temperature: 0.7,
    }),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(`Mistral ${r.status}: ${d?.message || 'failed'}`);
  const reply = d?.choices?.[0]?.message?.content;
  if (!reply) throw new Error('Mistral returned empty response');
  return reply;
}

// ── Provider: Gemini ──────────────────────────────────────────────────────────
async function callGemini(messages, systemPrompt) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');

  // Convert messages to Gemini format
  const prompt = (systemPrompt || UPSC_SYSTEM_PROMPT) + '\n\n' +
    messages.map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`).join('\n');

  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 1024, temperature: 0.7 },
      }),
    }
  );
  const d = await r.json();
  if (!r.ok) throw new Error(`Gemini ${r.status}: ${d?.error?.message || 'failed'}`);
  const reply = d?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!reply) throw new Error('Gemini returned empty response');
  return reply;
}

// ── Provider: OpenRouter ──────────────────────────────────────────────────────
async function callOpenRouter(messages, systemPrompt) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY not set');

  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'HTTP-Referer': 'https://upsc-guru-api.vercel.app',
      'X-Title': 'UPSC Guru',
    },
    body: JSON.stringify({
      model: 'mistralai/mistral-7b-instruct:free', // free model on OpenRouter
      messages: [
        { role: 'system', content: systemPrompt || UPSC_SYSTEM_PROMPT },
        ...messages,
      ],
      max_tokens: 1024,
      temperature: 0.7,
    }),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(`OpenRouter ${r.status}: ${d?.error?.message || 'failed'}`);
  const reply = d?.choices?.[0]?.message?.content;
  if (!reply) throw new Error('OpenRouter returned empty response');
  return reply;
}

// ── Smart chat router: tries all 4 providers in order ────────────────────────
async function smartChat(messages, systemPrompt) {
  const providers = [
    { name: 'Groq',       fn: () => callGroq(messages, systemPrompt) },
    { name: 'Mistral',    fn: () => callMistral(messages, systemPrompt) },
    { name: 'Gemini',     fn: () => callGemini(messages, systemPrompt) },
    { name: 'OpenRouter', fn: () => callOpenRouter(messages, systemPrompt) },
  ];

  const errors = [];
  for (const provider of providers) {
    try {
      const reply = await provider.fn();
      console.log(`[Chat] ${provider.name} success`);
      return { reply, provider: provider.name };
    } catch (e) {
      console.error(`[Chat] ${provider.name} failed:`, e.message);
      errors.push(`${provider.name}: ${e.message}`);
    }
  }

  throw new Error(`All providers failed: ${errors.join(' | ')}`);
}

// ── MCQ generation (Groq only — kept separate from chat) ─────────────────────
async function generateMCQ(topic) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('GROQ_API_KEY not set');

  const prompt = `Generate exactly 10 multiple choice questions for UPSC Civil Services exam on the topic: "${topic}".

Return ONLY a valid JSON array. Start directly with [ and end with ]. No text before or after.
Each object must have exactly these fields:
{
  "questionNumber": 1,
  "question": "question text",
  "options": { "A": "option", "B": "option", "C": "option", "D": "option" },
  "correctAnswer": "A",
  "explanation": "brief explanation",
  "topic": "${topic}"
}`;

  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
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
  if (s === -1 || e === -1) throw new Error('Invalid MCQ response format');
  return JSON.parse(clean.slice(s, e + 1));
}

// ── Main handler ──────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // IP rate limit (protects against bots)
  const ip = req.headers['x-forwarded-for'] || 'unknown';
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Too many requests. Please wait a moment.' });
  }

  const { messages, systemPrompt, topic, mode, userId } = req.body || {};

  // ── MCQ generation mode ──
  if (topic || mode === 'mcq') {
    const selectedTopic = topic || 'Indian History';
    try {
      const questions = await generateMCQ(selectedTopic);
      return res.status(200).json({ questions, topic: selectedTopic, source: 'groq' });
    } catch (e) {
      console.error('MCQ generation failed:', e.message);
      return res.status(500).json({ error: e.message });
    }
  }

  // ── Chat mode ──
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array is required' });
  }

  // Per-user daily limit (20 messages/day)
  if (!checkUserDailyLimit(userId)) {
    return res.status(429).json({
      error: 'daily_limit_reached',
      message: 'You have used all 20 AI messages for today. Your limit resets at midnight!',
    });
  }

  try {
    const { reply, provider } = await smartChat(messages, systemPrompt);
    return res.status(200).json({ reply, provider });
  } catch (e) {
    console.error('All chat providers failed:', e.message);
    return res.status(503).json({
      error: 'Our AI is very busy right now. Please try again in a moment!',
    });
  }
}