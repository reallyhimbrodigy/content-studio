const Anthropic = require('@anthropic-ai/sdk');
const dotenv = require('dotenv');

dotenv.config({ path: '.env.local' });

const anthropic = new Anthropic({
  apiKey: process.env.CLAUDE_API_KEY,
});

async function testClaudeAPI() {
  console.log('Testing Claude Opus 4.6 API...');

  try {
    const response = await anthropic.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 1024,
      thinking: { type: 'adaptive' },
      effort: 'high',
      messages: [
        {
          role: 'user',
          content: 'Return this JSON: {"test": "success", "model": "claude-opus-4-6"}',
        },
      ],
    });

    const text = Array.isArray(response?.content)
      ? response.content
          .filter((item) => item && item.type === 'text' && typeof item.text === 'string')
          .map((item) => item.text)
          .join('\n')
      : '';

    console.log('✅ Claude API works!');
    console.log('Response:', text || '[no text returned]');
  } catch (error) {
    console.error('❌ Claude API error:', error.message);
  }
}

testClaudeAPI();
