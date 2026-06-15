const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;

const UPSC_TOPICS = [
  'Indian History', 'Indian Polity', 'Indian Economy',
  'Geography of India', 'Environment and Ecology',
  'Science and Technology', 'Current Affairs', 'Art and Culture',
  'International Relations', 'Social Issues',
];

const RATE_LIMIT = new Map();
const RATE_LIMIT_WINDOW = 60000;
const MAX_REQUESTS = 10; // stricter for Gemini

function checkRateLimit(ip) {
  const now = Date.now();
  const requests = (RATE_LIMIT.get(ip) || []).filter(t => now - t < RATE_LIMIT_WINDOW);
  if (requests.length >= MAX_REQUESTS) return false;
  requests.push(now);
  RATE_LIMIT.set(ip, requests);
  return true;
}

function pickRandomTopic() {
  return UPSC_TOPICS[Math.floor(Math.random() * UPSC_TOPICS.length)];
}

function buildPrompt(topic) {
  return `Generate exactly 10 multiple choice questions for UPSC Civil Services exam on the topic: "${topic}".

Return ONLY a valid JSON array with no markdown, no explanation, no extra text before or after.
Start your response directly with [ and end with ].
Each object must have exactly these fields:
{
  "questionNumber": <number 1-10>,
  "question": "<question text>",
  "options": { "A": "<option>", "B": "<option>", "C": "<option>", "D": "<option>" },
  "correctAnswer": "<A or B or C or D>",
  "explanation": "<brief explanation>",
  "topic": "${topic}"
}`;
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

  const { topic, mode, weakTopics } = req.body;
  const finalTopic = topic ||
    (weakTopics?.length ? weakTopics[0] : pickRandomTopic());

  try {
    const response = await fetch(GEMINI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: buildPrompt(finalTopic) }] }],
        generationConfig: { temperature: 0.7, maxOutputTokens: 4096 },
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('Gemini error:', response.status, err);
      return res.status(500).json({ error: 'AI service temporarily unavailable' });
    }

    const data = await response.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) return res.status(500).json({ error: 'Empty response from Gemini' });

    // Extract JSON array
    const clean = text.replace(/```json|```/g, '').trim();
    const arrayStart = clean.indexOf('[');
    const arrayEnd = clean.lastIndexOf(']');
    if (arrayStart === -1 || arrayEnd === -1) {
      return res.status(500).json({ error: 'Invalid response format from Gemini' });
    }

    const questions = JSON.parse(clean.slice(arrayStart, arrayEnd + 1));
    if (!Array.isArray(questions) || questions.length === 0) {
      return res.status(500).json({ error: 'No questions generated' });
    }

    return res.json({ questions, topic: finalTopic });
  } catch (error) {
    console.error('Server error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
