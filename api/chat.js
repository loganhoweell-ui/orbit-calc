// ================================================================
//  Orbit Calc — AI Chat Serverless Function
//  Provider: Groq  (https://console.groq.com — 100% free tier)
//  Model:    llama-3.3-70b-versatile
//
//  Add this env var in Vercel project settings:
//    GROQ_API_KEY = gsk_...
//
//  For local dev, add to .env.local:
//    GROQ_API_KEY = gsk_...
//
//  Frontend POSTs to /api/chat:
//    { messages: [{ role: 'user'|'assistant', content: string }] }
// ================================================================

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: 'GROQ_API_KEY is not set. Add it to Vercel → Settings → Environment Variables.'
    });
  }

  const { messages, model } = req.body;
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array is required' });
  }

  // Whitelist allowed models so the client can't call arbitrary endpoints
  const ALLOWED_MODELS = [
    'llama-3.3-70b-versatile',
    'llama-3.1-8b-instant',
    'mixtral-8x7b-32768',
    'gemma2-9b-it',
    'llama3-8b-8192'
  ];
  const selectedModel = ALLOWED_MODELS.includes(model) ? model : 'llama-3.3-70b-versatile';

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: selectedModel,
        max_tokens: 1024,
        temperature: 0.7,
        messages: [
          {
            role: 'system',
            content: `You are Orbit AI, a helpful assistant built into Orbit Calc — a graphing calculator.
You have strong math and calculus knowledge. Be concise and friendly.
When showing expressions use plain text: x^2, sin(x), sqrt(x), etc.
The calculator supports:
- Functions: y = sin(x), y = x^2 + 3
- Inequalities: y > x + 2
- Implicit curves: x^2 + y^2 = 9
- Polar: r = cos(theta)
- Parametric: (cos(t), sin(t))
- Sliders: a = 3  {-10 <= a <= 10}
- Tables: click + Table button
- Calculus: click the ∫ button for tangents and integrals`
          },
          ...messages
        ]
      })
    });

    if (!response.ok) {
      const errBody = await response.json().catch(() => ({}));
      const errMsg = errBody.error?.message || `Groq API error ${response.status}`;
      return res.status(response.status).json({ error: errMsg });
    }

    const data = await response.json();
    const reply = data.choices?.[0]?.message?.content ?? 'No response.';

    // Return in a consistent format the frontend expects
    return res.status(200).json({
      content: [{ type: 'text', text: reply }]
    });

  } catch (err) {
    console.error('Orbit AI error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}
