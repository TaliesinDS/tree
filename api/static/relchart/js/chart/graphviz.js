import { Graphviz } from '../vendor/graphviz-wasm.js';

let _graphvizPromise = null;

export function getGraphviz() {
  if (!_graphvizPromise) {
    _graphvizPromise = Graphviz.load();
  }
  return _graphvizPromise;
}
