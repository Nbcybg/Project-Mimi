import type { Capability } from '@mimi/shared';
import type { ModelKey, ModelDefaults } from '../app/app-settings.ts';
import type { ModelInfo } from './registry.ts';

/** What a model must be, take or make to be usable for a key (the catalog's type and modalities). */
export const MODEL_NEEDS: Record<ModelKey, { types?: string[]; inputs?: string[]; outputs: string[] }> = {
  model: { types: ['chat'], outputs: ['text'] },
  small_model: { types: ['chat'], outputs: ['text'] },
  vision_model: { types: ['chat'], inputs: ['image', 'pdf', 'video'], outputs: ['text'] },
  transcript_model: { types: ['chat', 'transcription'], inputs: ['audio'], outputs: ['text'] },
  image_model: { types: ['image'], outputs: ['image'] },
  speech_model: { types: ['speech'], outputs: ['audio'] },
  video_model: { types: ['video'], outputs: ['video'] },
};

/** The capability a model key is resolved as, for `ModelService.resolve`. */
export const MODEL_CAPABILITY: Record<ModelKey, Capability> = {
  model: 'chat',
  small_model: 'summarize',
  vision_model: 'vision',
  transcript_model: 'transcript',
  image_model: 'image',
  speech_model: 'speech',
  video_model: 'video',
};

/** Rejects a model choice that the catalog says cannot do the job. Unknown metadata is allowed. */
export function checkModelNeeds(key: ModelKey, value: string, info: ModelInfo): void {
  const needs = MODEL_NEEDS[key];
  if (info.type && needs.types && !needs.types.includes(info.type)) {
    throw new Error(`Model "${value}" is not usable for "${key}" (type: ${info.type}).`);
  }
  if (info.inputs && needs.inputs && !needs.inputs.some((kind) => info.inputs!.includes(kind))) {
    throw new Error(`Model "${value}" does not take ${needs.inputs.join(' / ')} input: pick another model for "${key}".`);
  }
  if (info.outputs && !needs.outputs.every((kind) => info.outputs!.includes(kind))) {
    throw new Error(`Model "${value}" does not produce ${needs.outputs.join(' / ')}: pick another model for "${key}".`);
  }
}

/** Checks every model chosen for an agent (or the global defaults). */
export function checkModelChoice(
  choice: ModelDefaults,
  resolve: (key: ModelKey, value: string) => ModelInfo,
): void {
  for (const [key, value] of Object.entries(choice) as Array<[ModelKey, string | undefined]>) {
    if (!value) continue;
    checkModelNeeds(key, value, resolve(key, value));
  }
}
