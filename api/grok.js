import axios from 'axios';
import { API } from '../config/constants';
import { logError } from '../utils/errorHandler';
import { groqRateLimiter } from '../utils/rateLimiter';

interface AskGroqResponse {
  reply: string; // grok.js chat mode returns { reply: ... }
}

interface AxiosError {
  response?: {
    status?: number;
    data?: {
      error?: string;
    };
  };
  message?: string;
}

/**
 * Call Groq API via Vercel serverless function (api/grok.js).
 * API key stays on the server — never shipped in the app.
 */
export async function askGroq(message: string): Promise<string> {
  // Check rate limit before making request
  if (!groqRateLimiter.isAllowed('groq')) {
    const remaining = groqRateLimiter.getResetTime('groq');
    const waitTime = remaining ? Math.ceil((remaining - Date.now()) / 1000) : 60;
    throw new Error(`Rate limit exceeded. Please wait ${waitTime} seconds before trying again.`);
  }

  const MAX_RETRIES = 3;
  const RETRY_DELAY = 1500;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await axios.post<AskGroqResponse>(
        API.GROQ_SERVER,
        {
          // grok.js chat mode expects { messages, systemPrompt }
          messages: [{ role: 'user', content: message }],
          systemPrompt:
            'You are a UPSC Civil Services exam expert. Answer clearly and concisely, focused on the Indian context. Use bullet points where helpful.',
        },
        { timeout: 30_000 }
      );

      // grok.js returns { reply: "..." } for chat mode
      const text = response.data.reply;
      if (!text) throw new Error('Empty response from AI');
      return text;
    } catch (error: unknown) {
      logError('askGroq', error);

      const axiosError = error as AxiosError;

      if (attempt === MAX_RETRIES) {
        throw new Error(
          axiosError.response?.data?.error ||
            axiosError.message ||
            'Failed to get AI response. Please try again.'
        );
      }

      // Exponential back-off between retries
      await new Promise((r) => setTimeout(r, RETRY_DELAY * attempt));
    }
  }

  throw new Error('Failed to get AI response after multiple attempts.');
}