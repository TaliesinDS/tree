import { getGraphviz } from './graphviz.js';
import { enableSvgPanZoom } from './panzoom.js';
import {
  computeHiddenChildFamiliesByPersonId,
  computeHiddenParentFamiliesByPersonId,
} from './payload.js';
import { buildRelationshipDot } from './dot.js';

function addBadge(g, { x, y, label, title, onClick }) {
  const ns = 'http://www.w3.org/2000/svg';
  const group = document.createElementNS(ns, 'g');
  group.setAttribute('class', 'relchart-badge');
  group.style.cursor = 'pointer';

  const circle = document.createElementNS(ns, 'circle');
  circle.setAttribute('cx', String(x));
  circle.setAttribute('cy', String(y));
  circle.setAttribute('r', '10');
  circle.setAttribute('fill', 'rgba(122,162,255,0.95)');
  circle.setAttribute('stroke', 'rgba(0,0,0,0.25)');
  circle.setAttribute('stroke-width', '1');

  const text = document.createElementNS(ns, 'text');
  text.setAttribute('x', String(x));
  text.setAttribute('y', String(y + 4));
  text.setAttribute('text-anchor', 'middle');
  text.setAttribute('font-size', '12');
  text.setAttribute('font-family', 'Inter, Segoe UI, Arial');
  text.setAttribute('fill', '#0b0f16');
  text.textContent = label;

  const t = document.createElementNS(ns, 'title');
  t.textContent = title;
  group.appendChild(t);
  group.appendChild(circle);
  group.appendChild(text);
  group.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    onClick?.();
  });
  g.appendChild(group);
}

export async function renderRelationshipChart({
  container,
  payload,
  onSelectPerson,
  onExpandParents,
  onExpandChildren,
  onFit,
}) {
  const gv = await getGraphviz();
  const dot = buildRelationshipDot(payload, { couplePriority: true });

  const svgText = (typeof gv.layout === 'function')
    ? gv.layout(dot, 'svg', 'dot')
    : gv.dot(dot);

  container.innerHTML = svgText;
  const svg = container.querySelector('svg');
  if (!svg) return { panZoom: null };

  svg.style.display = 'block';
  svg.style.maxWidth = 'none';
  svg.style.width = '100%';
  svg.style.height = '100%';
  svg.setAttribute('preserveAspectRatio', 'xMinYMin meet');
  svg.style.touchAction = 'none';

  const panZoom = enableSvgPanZoom(svg, { container });

  const peopleIds = new Set((payload?.nodes || []).filter(n => n?.type === 'person').map(n => String(n.id)));
  const familyIds = new Set((payload?.nodes || []).filter(n => n?.type === 'family').map(n => String(n.id)));

  const hiddenParents = computeHiddenParentFamiliesByPersonId(payload);
  const hiddenChildren = computeHiddenChildFamiliesByPersonId(payload);

  // Click handlers + badges
  for (const node of svg.querySelectorAll('g.node')) {
    const id = node.querySelector('title')?.textContent?.trim();
    if (!id) continue;

    if (peopleIds.has(id)) {
      node.style.cursor = 'pointer';
      node.addEventListener('click', () => onSelectPerson?.(id));

      const famsUp = hiddenParents.get(id) || [];
      const famsDown = hiddenChildren.get(id) || [];

      const bbox = node.getBBox();
      const g = node;

      if (famsUp.length) {
        addBadge(g, {
          x: bbox.x + bbox.width - 10,
          y: bbox.y + 10,
          label: '↑',
          title: `Expand parents (${famsUp.length})`,
          onClick: () => onExpandParents?.({ personId: id, familyId: famsUp[0] }),
        });
      }
      if (famsDown.length) {
        addBadge(g, {
          x: bbox.x + bbox.width - 10,
          y: bbox.y + bbox.height - 10,
          label: '↓',
          title: `Expand children (${famsDown.length})`,
          onClick: () => onExpandChildren?.({ personId: id, familyId: famsDown[0] }),
        });
      }
      continue;
    }

    if (familyIds.has(id)) {
      node.style.cursor = 'pointer';
      node.addEventListener('click', () => onExpandChildren?.({ familyId: id }));
    }
  }

  // Fit shortcut for callers.
  if (onFit) {
    onFit(() => panZoom.reset());
  }

  return { panZoom };
}
