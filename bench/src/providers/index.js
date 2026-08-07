import { makeHaenProvider } from './haen.js';

// The extension point. A config names a provider here; adding a backend means adding a
// factory and a line in this map, and touching nothing else in the harness.
//
// Deliberately a plain object, not a class hierarchy or a registration decorator. A
// provider is a function from a dataset item to a prediction record - there is no state
// worth an object and no second implementation worth an interface yet.
export const PROVIDERS = {
  haen: makeHaenProvider,
};

export function makeProvider(config) {
  const factory = PROVIDERS[config.harness ?? 'haen'];
  if (!factory) {
    throw new Error(`Unknown harness "${config.harness}". Known: ${Object.keys(PROVIDERS).join(', ')}`);
  }
  return factory(config);
}
