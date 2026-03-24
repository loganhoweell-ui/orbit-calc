// ================================================================
//  Orbit Calc — AI Chat Serverless Function
//  Deployed via Vercel (api/chat.js)
//
//  Set the following env var in your Vercel project settings:
//    ANTHROPIC_API_KEY = sk-ant-...
//
//  The frontend calls POST /api/chat with:
//    { messages: [{ role: 'user'|'assistant', content: string }] }
// ================================================================

export default async function handler(req, res) {
  // Only allow POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: 'ANTHROPIC_API_KEY is not set. Add it to your Vercel environment variables.'
    });
  }

  const { messages } = req.body;
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages array is required' });
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        system: `You are Orbit AI, a helpful assistant embedded in Orbit Calc — a graphing calculator.
You're knowledgeable about math, calculus, graphing, equations, and general topics.
Keep responses concise and friendly. When showing math expressions, use plain text notation like x^2 or sin(x).
The calculator supports: y=f(x), inequalities, implicit equations like x^2+y^2=9, polar r=f(theta), parametric (f(t),g(t)), sliders like a=3, and tables.`,
        messages
      })
    });

    if (!response.ok) {
      const errBody = await response.json().catch(() => ({}));
      return res.status(response.status).json({
        error: errBody.error?.message || `Anthropic API error ${response.status}`
      });
    }

    const data = await response.json();
    return res.status(200).json(data);

  } catch (err) {
    console.error('AI chat error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}
