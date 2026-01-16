import { Graphviz } from 'https://unpkg.com/@hpcc-js/wasm-graphviz@1.18.0/dist/index.js';

let _graphvizPromise = null;

export function getGraphviz() {
  if (!_graphvizPromise) {
    _graphvizPromise = Graphviz.load();
  }
  return _graphvizPromise;
}
