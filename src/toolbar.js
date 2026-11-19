import L from 'leaflet';

/**
 * Barre d'outils de la carte, en blocs, avec l'apparence de la barre de Geoman.
 * Geoman reste le moteur de dessin et d'édition : cette barre ne fait qu'appeler ses fonctions,
 * ce qui permet des blocs thématiques et des modes limités à un type d'objet.
 *
 * blocks : [{ id, title, color, buttons: [{ id, title, icon?, text?, onClick }] }]
 *  - icon : nom d'une icône Geoman (polygon, polyline, edit, drag, delete, cut…)
 *  - text : caractère ou emoji affiché à la place d'une icône (color : sa couleur)
 */
export function createToolbar(map, blocks, { position = 'topleft' } = {}) {
  const buttons = new Map(); // id -> élément .button-container
  const blockEls = new Map(); // id -> élément du bloc
  let allowed = blocks.map((b) => b.id); // blocs affichables (voir showBlocks)
  // un bloc est masqué s'il n'est pas affichable ou si aucun de ses boutons n'est visible
  const layout = () => {
    for (const [id, el] of blockEls) el.hidden = !allowed.includes(id) || !el.querySelector('.button-container:not([hidden])');
  };

  const Control = L.Control.extend({
    onAdd() {
      const root = L.DomUtil.create('div', 'fency-toolbar');
      L.DomEvent.disableClickPropagation(root);
      L.DomEvent.disableScrollPropagation(root);
      for (const block of blocks) {
        const el = L.DomUtil.create('div', 'leaflet-pm-toolbar leaflet-bar fency-block', root);
        el.title = block.title;
        el.dataset.block = block.id;
        if (block.color) el.style.setProperty('--block-color', block.color);
        blockEls.set(block.id, el);
        for (const b of block.buttons) {
          const box = L.DomUtil.create('div', 'button-container', el);
          const a = L.DomUtil.create('a', 'leaflet-buttons-control-button', box);
          a.href = '#'; a.role = 'button'; a.title = b.title; a.setAttribute('aria-label', b.title);
          const icon = L.DomUtil.create('div', b.icon ? `control-icon leaflet-pm-icon-${b.icon}` : 'control-icon fency-icon', a);
          if (!b.icon) icon.textContent = b.text ?? '';
          if (b.color) icon.style.color = b.color;
          L.DomUtil.create('span', 'fency-badge', a);
          L.DomEvent.on(a, 'click', (e) => {
            L.DomEvent.preventDefault(e);
            if (!box.classList.contains('disabled')) b.onClick(e);
          });
          buttons.set(b.id, box);
        }
      }
      return root;
    },
  });
  const control = new Control({ position }).addTo(map);
  // la barre ne dépasse jamais la carte (ni la pastille d'infos en bas) : au-delà, elle défile
  const fit = () => { control.getContainer().style.maxHeight = `${Math.max(120, map.getSize().y - 64)}px`; };
  map.on('resize', fit); fit();

  return {
    control,
    /** Bouton enfoncé (outil actif). */
    setActive(id, on) { buttons.get(id)?.classList.toggle('active', !!on); },
    /** Petit compteur sur un bouton ('' pour l'effacer). */
    setBadge(id, text) { const el = buttons.get(id)?.querySelector('.fency-badge'); if (el) el.textContent = text ?? ''; },
    /** Affiche ou masque un bouton (le bloc disparaît s'il n'a plus de bouton visible). */
    setVisible(id, on) { const el = buttons.get(id); if (el && el.hidden === !!on) { el.hidden = !on; layout(); } },
    /** Ajuste la hauteur maximale à la carte (après un changement de mise en page). */
    fit,
    /** N'affiche que les blocs donnés. */
    showBlocks(ids) { allowed = ids; layout(); },
  };
}
