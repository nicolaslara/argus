// @argus/server — the LLM layer. ONE home for everything model-facing: the runner (the single
// place to swap the model / flags / timeout) and every prompt (each its own file under prompts/,
// with its version + parser, so iterating on prompting / context / pre-processing is local). The
// feature ENGINES (caption warming pool in ../explain.ts, the sub-UI cache in ../subui.ts, and the
// M4 narrative-summary engine to come) consume these. Re-exported here for a single import point.

export { LLM_MODEL, CLAUDE_TIMEOUT_MS, defaultClaudeRunner, type ClaudeRunner } from './runner.ts';
export { DiskCache } from './cache.ts';
export {
  PROMPT_VERSION as CAPTION_PROMPT_VERSION,
  MAX_CAPTION_LEN,
  type NodeArtifact,
  hashArtifact,
  buildPrompt as buildCaptionPrompt,
  parsePattern,
  cleanCaption,
} from './prompts/caption.ts';
export { SUBUI_PROMPT_VERSION, buildSubUiPrompt, parseSubUiSpec } from './prompts/panel.ts';
