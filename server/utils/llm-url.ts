import { llmUrlError } from '../lib/llm'

export async function assertLlmBaseUrl(url: string): Promise<void> {
  const error = await llmUrlError(url)
  if (error) throw createError({ statusCode: 400, statusMessage: error })
}
