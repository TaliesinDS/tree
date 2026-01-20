export const $ = (id) => document.getElementById(id);

export const els = {
  personId: $('personId'),
  depth: $('depth'),
  maxNodes: $('maxNodes'),
  loadBtn: $('loadBtn'),
  fitBtn: $('fitBtn'),
  resetBtn: $('resetBtn'),
  status: $('status'),
  chart: $('chart'),
  graphView: $('graphView'),
  mapView: $('mapView'),
  mapAttribution: $('mapAttribution'),

  graphControls: $('graphControls'),
  mapControls: $('mapControls'),
  mapBasemap: $('mapBasemap'),
  mapPinsMenu: $('mapPinsMenu'),
  mapPinsBtn: $('mapPinsBtn'),
  mapPinsEnabled: $('mapPinsEnabled'),
  mapPinsMax: $('mapPinsMax'),
  mapScope: $('mapScope'),
  mapRoutesToggle: $('mapRoutesToggle'),
  mapRoutesMode: $('mapRoutesMode'),
  mapRoutesMenu: $('mapRoutesMenu'),
  mapRoutesSkipRepeated: $('mapRoutesSkipRepeated'),
  mapFitPinsBtn: $('mapFitPinsBtn'),
  mapClearOverlaysBtn: $('mapClearOverlaysBtn'),

  peopleSearch: $('peopleSearch'),
  peopleSearchClear: $('peopleSearchClear'),
  peopleStatus: $('peopleStatus'),
  peopleList: $('peopleList'),
  peopleExpandToggle: $('peopleExpandToggle'),
  familiesSearch: $('familiesSearch'),
  familiesSearchClear: $('familiesSearchClear'),
  familiesStatus: $('familiesStatus'),
  familiesList: $('familiesList'),
  eventsSearch: $('eventsSearch'),
  eventsSearchClear: $('eventsSearchClear'),
  eventsStatus: $('eventsStatus'),
  eventsList: $('eventsList'),
  eventsSort: $('eventsSort'),
  placesSearch: $('placesSearch'),
  placesSearchClear: $('placesSearchClear'),
  placesStatus: $('placesStatus'),
  placesList: $('placesList'),
  optPeopleWidePx: $('optPeopleWidePx'),
  optionsMenu: $('optionsMenu'),
  personDetailPanel: $('personDetailPanel'),
  placeEventsPanel: null,
};

export const state = {
  payload: null,
  selectedPersonId: null,
  panZoom: null,
  people: null,
  peopleLoaded: false,
  peopleSelected: null,
  peopleExpanded: false,
  families: null,
  familiesLoaded: false,
  familiesSelected: null,
  familiesClicksWired: false,
  events: null,
  eventsLoaded: false,
  eventsSelected: null,
  eventsSort: 'type_asc',
  eventsQuery: '',
  eventsOffset: 0,
  eventsHasMore: false,
  eventsTotal: null,
  eventsLoading: false,
  eventsReqSeq: 0,
  eventsPageSize: 500,
  eventsServerMode: true,
  places: null,
  placesLoaded: false,
  placesSelected: null,
  placesQuery: '',
  placeById: new Map(),
  placeEventCountById: new Map(),
  placeEventsByPlaceId: new Map(),
  placeEventsPanel: {
    open: false,
    placeId: null,
    wiredScroll: false,
  },
  map: {
    leafletLoading: false,
    leafletReady: false,
    map: null,
    marker: null,
    lastCenteredPlaceId: null,
    pendingPlaceId: null,
    baseLayer: null,
    baseLayers: null,
    pinsLayer: null,
    routesLayer: null,
  },
  mapUi: {
    basemap: 'topo',
    pinsEnabled: true,
    pinsMax: 2000,
    scope: 'selected_person',
    routesEnabled: false,
    routesMode: 'person',
    routesSkipRepeated: true,
    pinsCount: 0,
    routePoints: 0,
    overlayRenderKey: '',
    autoFitPending: false,
    overlayRefreshTimer: null,
    personDetailsCache: new Map(),
  },
  nodeById: new Map(),
  detailPanel: {
    open: false,
    activeTab: 'details',
    lastPersonId: null,
    lastReqSeq: 0,
    drag: { active: false, dx: 0, dy: 0 },
    resize: { active: false, startY: 0, startH: 0 },
    pos: { left: 48, top: 72 },
    size: { h: null },
    peek: { url: '', name: '', loading: false },
  },

  status: {
    lastNonMapMsg: 'Ready.',
    lastNonMapIsError: false,
  },
};

export const MAP_SETTINGS = {
  basemap: 'tree_relchart_map_basemap',
  pinsEnabled: 'tree_relchart_map_pins_enabled',
  pinsMax: 'tree_relchart_map_pins_max',
  scope: 'tree_relchart_map_scope',
  routesEnabled: 'tree_relchart_map_routes_enabled',
  routesMode: 'tree_relchart_map_routes_mode',
  routesSkipRepeated: 'tree_relchart_map_routes_skip_repeated',
};

export function _readBool(key, fallback) {
  try {
    const v = String(localStorage.getItem(key) || '').trim().toLowerCase();
    if (!v) return !!fallback;
    if (v === '1' || v === 'true' || v === 'yes' || v === 'on') return true;
    if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false;
    return !!fallback;
  } catch (_) {
    return !!fallback;
  }
}

export function _readInt(key, fallback) {
  try {
    const raw = String(localStorage.getItem(key) || '').trim();
    const n = Number(raw);
    return Number.isFinite(n) ? Math.trunc(n) : fallback;
  } catch (_) {
    return fallback;
  }
}

export function _writeSetting(key, value) {
  try { localStorage.setItem(key, String(value)); } catch (_) {}
}
