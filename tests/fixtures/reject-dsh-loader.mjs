export async function resolve(specifier, context, nextResolve) {
  if (specifier.includes('@deepseek-ai/') || specifier.includes('@deepseek-ai+')) throw new Error('DSH_RUNTIME_IMPORT: ' + specifier)
  return nextResolve(specifier, context)
}
