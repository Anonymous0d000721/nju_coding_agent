import type { ApiFormat } from '../app/cli-args.js';
import type { ModelClient } from './model-client.js';
import { AnthropicClient } from './anthropic.js';
import { OpenAICompatibleClient } from './openai-compatible.js';
import { OpenAIResponsesClient } from './openai-responses.js';

export function createModelClient(options: { apiFormat: ApiFormat; apiKey: string; baseUrl: string; model: string }): ModelClient {
  if (options.apiFormat === 'anthropic') return new AnthropicClient(options);
  if (options.apiFormat === 'openai-responses') return new OpenAIResponsesClient(options);
  return new OpenAICompatibleClient(options);
}
