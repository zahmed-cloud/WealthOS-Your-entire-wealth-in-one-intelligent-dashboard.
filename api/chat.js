// /api/chat.js — Vercel Serverless Function
// Proxies chat requests to Anthropic Claude API
// Called by WealthOS frontend: POST /api/chat { messages, systemPrompt, userId, plan }
//
// SETUP: Add ANTHROPIC_API_KEY to Vercel Environment Variables
//   1. Go to console.anthropic.com → API Keys → Create Key
//   2. Go to vercel.com → your project → Settings → Environment Variables
//   3. Add: ANTHROPIC_API_KEY = sk-ant-...

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  // Check for API key
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(503).json({
      error: 'ai_not_configured',
      message: 'AI assistant is being set up. Please try again shortly.',
    });
  }

  try {
    const { messages, systemPrompt, userId, plan } = req.body || {};

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'missing_messages', message: 'No messages provided.' });
    }

    // Rate limiting (simple in-memory, per userId)
    const now = Date.now();
    if (!global._chatLimits) global._chatLimits = {};
    const limits = global._chatLimits;
    const key = userId || 'anon';
    if (!limits[key]) limits[key] = { count: 0, reset: now + 86400000 };
    if (now > limits[key].reset) { limits[key] = { count: 0, reset: now + 86400000 }; }

    const maxMessages = plan === 'pro' || plan === 'private' ? 999 : 20;
    limits[key].count++;
    if (limits[key].count > maxMessages) {
      return res.status(429).json({
        error: 'rate_limit',
        message: 'Daily message limit reached. Upgrade to Pro for unlimited AI chat.',
        usage: { count: limits[key].count, limit: maxMessages },
      });
    }

    // Format messages for Anthropic API
    const anthropicMessages = messages.map(function(m) {
      return {
        role: m.role === 'ai' || m.role === 'assistant' ? 'assistant' : 'user',
        content: m.content || m.text || '',
      };
    }).filter(function(m) {
      return m.content.length > 0;
    });

    // Ensure messages alternate correctly
    const cleaned = [];
    for (let i = 0; i < anthropicMessages.length; i++) {
      const msg = anthropicMessages[i];
      if (cleaned.length === 0) {
        if (msg.role !== 'user') continue; // First must be user
        cleaned.push(msg);
      } else {
        if (msg.role === cleaned[cleaned.length - 1].role) {
          // Merge same-role messages
          cleaned[cleaned.length - 1].content += '\n' + msg.content;
        } else {
          cleaned.push(msg);
        }
      }
    }

    if (cleaned.length === 0) {
      return res.status(400).json({ error: 'no_valid_messages' });
    }

    // Ensure last message is from user
    if (cleaned[cleaned.length - 1].role !== 'user') {
      cleaned.pop();
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        system: systemPrompt || 'You are a helpful wealth management assistant.',
        messages: cleaned,
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      console.error('Anthropic API error:', response.status, errorBody);

      if (response.status === 401) {
        return res.status(500).json({ error: 'ai_auth_failed', message: 'AI configuration error. Please check API key.' });
      }
      if (response.status === 429) {
        return res.status(429).json({ error: 'rate_limit', message: 'AI is busy. Please wait a moment.' });
      }
      return res.status(500).json({ error: 'ai_error', message: 'AI temporarily unavailable.' });
    }

    const data = await response.json();

    // Extract text from response
    let reply = '';
    if (data.content && Array.isArray(data.content)) {
      reply = data.content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('\n');
    }

    return res.status(200).json({
      reply: reply || 'I could not generate a response. Please try again.',
      usage: {
        count: limits[key].count,
        limit: maxMessages,
      },
    });

  } catch (err) {
    console.error('chat.js error:', err);
    return res.status(500).json({
      error: 'server_error',
      message: 'Assistant temporarily unavailable. Please try again.',
    });
  }
}