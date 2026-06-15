export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'GROQ_API_KEY not configured' });

  const { messages, systemPrompt, topic, mode } = req.body || {};

  // MCQ generation mode
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
      const s = clean.indexOf('['), e = clean.lastIndexOf(']');
      if (s === -1 || e === -1) return res.status(502).json({ error: 'Invalid response from Groq' });
      const questions = JSON.parse(clean.slice(s, e + 1));
      return res.status(200).json({ questions, topic: selectedTopic, source: 'groq' });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // Chat mode (existing AI assistant feature)
  try {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [
          ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
          ...(messages || []),
        ],
        max_tokens: 1024,
        temperature: 0.7,
      }),
    });
    const d = await r.json();
    return res.status(200).json({ reply: d?.choices?.[0]?.message?.content || '' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}