export const clampSize = (value, min, max) => Math.min(Math.max(Math.round(value), min), Math.max(min, max));

export function installSplitters(load, save) {
  const main = document.querySelector('#main-area');
  const panels = {
    filer: { horizontal: true, sign: 1, min: 162, max: () => main.clientWidth * .35 },
    sessions: { horizontal: true, sign: -1, min: 180, max: () => main.clientWidth * .35 },
    tree: { sign: 1, min: 44, max: () => document.querySelector('#sessions').clientHeight - 175 },
    dock: { sign: -1, min: 75, max: () => window.innerHeight - 375 },
  };
  const size = id => {
    const element = id === 'dock' ? document.querySelector('#dock [role="tabpanel"]:not([hidden])')
      : document.getElementById(id);
    return element?.getBoundingClientRect()[panels[id].horizontal ? 'width' : 'height'] ?? 0;
  };
  const layout = {};
  for (const handle of document.querySelectorAll('[data-split]')) {
    const id = handle.dataset.split;
    const { horizontal, sign, min, max } = panels[id];
    const property = `--${id}-size`;
    const style = document.querySelector('.workspace').style;
    if (Number.isFinite(load?.[id]) && load[id] > 0) {
      layout[id] = Math.round(load[id]);
      style.setProperty(property, `${layout[id]}px`);
    }
    const updateAria = () => {
      handle.setAttribute('aria-valuemin', min);
      handle.setAttribute('aria-valuemax', Math.floor(Math.max(min, max())));
      handle.setAttribute('aria-valuenow', clampSize(size(id), min, Math.floor(max())));
    };
    const apply = value => {
      layout[id] = clampSize(value, min, Math.floor(max()));
      style.setProperty(property, `${layout[id]}px`);
      updateAria();
    };
    const coordinate = event => horizontal ? event.clientX : event.clientY;
    let drag = null;
    handle.addEventListener('pointerdown', event => {
      if (event.button !== 0 || drag) return;
      event.preventDefault();
      handle.focus();
      drag = { id: event.pointerId, start: coordinate(event), size: size(id) };
      handle.setPointerCapture(event.pointerId);
      handle.classList.add('dragging');
      document.body.style.setProperty('--resize-cursor', horizontal ? 'col-resize' : 'row-resize');
      document.body.classList.add('resizing');
    });
    handle.addEventListener('pointermove', event => {
      if (drag?.id === event.pointerId) apply(drag.size + sign * (coordinate(event) - drag.start));
    });
    const finish = event => {
      if (drag?.id !== event.pointerId) return;
      drag = null;
      handle.classList.remove('dragging');
      document.body.classList.remove('resizing');
      save(layout);
    };
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', finish);
    handle.addEventListener('lostpointercapture', finish);
    const reset = () => {
      delete layout[id];
      style.removeProperty(property);
      updateAria();
      save(layout);
    };
    handle.addEventListener('dblclick', reset);
    handle.addEventListener('keydown', event => {
      const keys = horizontal ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown'];
      if (![...keys, 'Home', 'End', 'Enter'].includes(event.key)) return;
      event.preventDefault();
      if (event.key === 'Enter') return reset();
      const step = (event.key === keys[0] ? -1 : 1) * sign * (event.shiftKey ? 40 : 12);
      apply(event.key === 'Home' ? min : event.key === 'End' ? max() : size(id) + step);
      save(layout);
    });
    new ResizeObserver(updateAria).observe(handle);
  }
}
