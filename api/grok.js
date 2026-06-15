const GROQ_API_KEY = process.env.GROQ_API_KEY;

const RATE_LIMIT = new Map();
const RATE_LIMIT_WINDOW = 60000;
const MAX_REQUESTS = 30;

function checkRateLimit(ip) {
  const now = Date.now();
  const requests = (RATE_LIMIT.get(ip) || []).filter(t => now - t < RATE_LIMIT_WINDOW);
  if (requests.length >= MAX_REQUESTS) return false;
  requests.push(now);
  RATE_LIMIT.set(ip, requests);
  return true;
}

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ip = req.headers['x-forwarded-for'] || 'unknown';
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Too many requests. Try again later.' });
  }

  const { message } = req.body;
  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'Message is required' });
  }
  if (message.length > 2000) {
    return res.status(400).json({ error: 'Message too long (max 2000 characters)' });
  }

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        messages: [
          {
            role: 'system',
            content: 'You are a UPSC exam preparation expert. Answer questions clearly and concisely in simple English. Focus on UPSC relevance. Keep answers under 200 words.',
          },
          { role: 'user', content: message.trim() },
        ],
        max_tokens: 500,
        temperature: 0.7,
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('Groq error:', response.status, err);
      return res.status(500).json({ error: 'AI service temporarily unavailable' });
    }

    const data = await response.json();
    const text = data?.choices?.[0]?.message?.content;
    if (!text) return res.status(500).json({ error: 'Empty response from AI' });

    return res.json({ text });
  } catch (error) {
    console.error('Server error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
