import * as api from './api.js';
import { renderRelationshipChart } from './chart/render.js';
import { mergeGraphPayload } from './chart/payload.js';

const $ = (id) => document.getElementById(id);

const els = {
  personId: $('personId'),
  depth: $('depth'),
  maxNodes: $('maxNodes'),
  loadBtn: $('loadBtn'),
  fitBtn: $('fitBtn'),
  resetBtn: $('resetBtn'),
  status: $('status'),
  chart: $('chart'),
  peopleSearch: $('peopleSearch'),
  peopleStatus: $('peopleStatus'),
  peopleList: $('peopleList'),
};

const state = {
  payload: null,
  selectedPersonId: null,
  panZoom: null,
  people: null,
  peopleLoaded: false,
  peopleSelected: null,
};

function setStatus(msg, isError = false) {
  els.status.textContent = String(msg ?? '');
  els.status.style.color = isError ? 'var(--danger)' : 'var(--muted)';
}

async function rerender() {
  if (!state.payload) return;
  const { panZoom } = await renderRelationshipChart({
    container: els.chart,
    payload: state.payload,
    onSelectPerson: (pid) => {
      state.selectedPersonId = pid;
      setStatus(`Selected: ${pid}`);
    },
    onExpandParents: async ({ personId, familyId }) => {
      if (!familyId) return;
      setStatus(`Expanding parents: ${familyId} …`);
      const delta = await api.familyParents({ familyId, childId: personId });
      state.payload = mergeGraphPayload(state.payload, delta);
      await rerender();
    },
    onExpandChildren: async ({ familyId }) => {
      if (!familyId) return;
      setStatus(`Expanding children: ${familyId} …`);
      const delta = await api.familyChildren({ familyId, includeSpouses: true });
      state.payload = mergeGraphPayload(state.payload, delta);
      await rerender();
    },
    onFit: (fn) => {
      els.fitBtn.onclick = fn;
    },
  });

  state.panZoom = panZoom;
}

async function loadNeighborhood() {
  const personId = String(els.personId.value || '').trim();
  const depth = Number(els.depth.value || '2');
  const maxNodes = Number(els.maxNodes.value || '1000');

  if (!personId) {
    setStatus('Missing Person ID', true);
    return;
  }

  setStatus('Loading…');
  try {
    state.payload = await api.neighborhood({ personId, depth, maxNodes });
    state.selectedPersonId = null;
    setStatus(`Loaded ${state.payload.nodes?.length || 0} nodes, ${state.payload.edges?.length || 0} edges.`);
    await rerender();
  } catch (e) {
    setStatus(`Failed: ${e?.message || e}`, true);
  }
}

els.loadBtn.addEventListener('click', loadNeighborhood);

els.resetBtn.addEventListener('click', () => {
  state.payload = null;
  state.selectedPersonId = null;
  els.chart.innerHTML = '';
  setStatus('Ready.');
});

els.fitBtn.addEventListener('click', () => {
  state.panZoom?.reset?.();
});

// Initial
setStatus('Ready.');

function _normKey(s) {
  return String(s || '').trim().toLowerCase();
}

function _displayPersonLabel(p) {
  const name = String(p?.display_name || '');
  const gid = String(p?.gramps_id || '').trim();
  return gid ? `${name} (${gid})` : name;
}

function _surnameGroupLabel(p) {
  const s = String(p?.surname || '').trim();
  if (!s || s === '?') return 'No surname';
  return s;
}

function _renderPeopleList(people, query) {
  if (!els.peopleList) return;

  const q = _normKey(query);
  const filtered = q
    ? people.filter((p) => _normKey(_displayPersonLabel(p)).includes(q))
    : people;

  const groups = new Map();
  for (const p of filtered) {
    const k = _surnameGroupLabel(p);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(p);
  }

  const groupNames = Array.from(groups.keys()).sort((a, b) => a.localeCompare(b));
  // Force No surname group at top.
  const noSurnameIdx = groupNames.indexOf('No surname');
  if (noSurnameIdx > 0) {
    groupNames.splice(noSurnameIdx, 1);
    groupNames.unshift('No surname');
  }

  els.peopleList.innerHTML = '';
  const frag = document.createDocumentFragment();

  for (const groupName of groupNames) {
    const peopleInGroup = groups.get(groupName) || [];
    const details = document.createElement('details');
    details.className = 'peopleGroup';
    details.open = false;

    const summary = document.createElement('summary');
    summary.textContent = `${groupName} (${peopleInGroup.length})`;
    details.appendChild(summary);

    for (const p of peopleInGroup) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'peopleItem';

      const key = String(p?.gramps_id || p?.id || '').trim();
      btn.dataset.personKey = key;
      if (state.peopleSelected && state.peopleSelected === key) {
        btn.classList.add('selected');
      }

      const nameEl = document.createElement('div');
      nameEl.className = 'name';
      nameEl.textContent = String(p?.display_name || '');

      const metaEl = document.createElement('div');
      metaEl.className = 'meta';
      metaEl.textContent = String(p?.gramps_id || p?.id || '');

      btn.appendChild(nameEl);
      btn.appendChild(metaEl);

      btn.addEventListener('click', async () => {
        const ref = String(p?.gramps_id || p?.id || '').trim();
        if (!ref) return;
        state.peopleSelected = ref;
        els.personId.value = ref;
        await loadNeighborhood();
        _renderPeopleList(state.people || [], els.peopleSearch?.value || '');
      });

      details.appendChild(btn);
    }

    frag.appendChild(details);
  }

  frag && els.peopleList.appendChild(frag);

  if (els.peopleStatus) {
    els.peopleStatus.textContent = `Showing ${filtered.length} of ${people.length}.`;
  }
}

async function ensurePeopleLoaded() {
  if (state.peopleLoaded) return;
  if (!els.peopleStatus || !els.peopleList) return;

  els.peopleStatus.textContent = 'Loading people…';
  try {
    // 50k hard limit on the endpoint; typical trees are much smaller (you have ~4k).
    const r = await fetch('/people?limit=50000&offset=0');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    const results = Array.isArray(data?.results) ? data.results : [];
    state.people = results;
    state.peopleLoaded = true;
    _renderPeopleList(results, els.peopleSearch?.value || '');
  } catch (e) {
    els.peopleStatus.textContent = `Failed to load people: ${e?.message || e}`;
  }
}

// Load people list lazily when the People tab is opened.
const peopleTabBtn = document.querySelector('.tabbtn[data-tab="people"]');
if (peopleTabBtn) {
  peopleTabBtn.addEventListener('click', () => {
    ensurePeopleLoaded();
  });
}

if (els.peopleSearch) {
  els.peopleSearch.addEventListener('input', () => {
    if (!state.peopleLoaded || !state.people) return;
    _renderPeopleList(state.people, els.peopleSearch.value);
  });
}
