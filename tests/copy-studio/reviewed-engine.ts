// Existing claim/source regression fixtures isolate the writing pipeline. Semantic-review
// behavior uses the real engine separately in persuasion-review.test.ts.
import { generate as realGenerate, revise as realRevise } from '../../src/lib/copy-studio/server/engine';
import { PERSUASION_EDITOR } from '../../src/lib/copy-studio/server/persuasion-review';
import type { Completion } from '../../src/lib/copy-studio/server/provider';
export { extract } from '../../src/lib/copy-studio/server/engine';
function withPassingReview(complete: Completion): Completion {
  const wrapped: Completion = (system, prompt, signal, maxTokens) => system.startsWith(PERSUASION_EDITOR)
    ? Promise.resolve('{"findings":[]}') : complete(system, prompt, signal, maxTokens);
  Object.defineProperty(wrapped, 'inputByteLimit', {
    get: () => complete.inputByteLimit, set: value => { complete.inputByteLimit = value; },
  });
  return wrapped;
}
export const generate: typeof realGenerate = (complete, ...args) => realGenerate(withPassingReview(complete), ...args);
export const revise: typeof realRevise = (complete, ...args) => realRevise(withPassingReview(complete), ...args);
