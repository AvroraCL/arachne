const svg = content => `<svg class="chrome-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${content}</svg>`;

export const workspaceIcons = {
  meshObject: svg('<path class="mesh-face" d="m10 3 7 13H3Z"/><path d="M9 2h2v2H9ZM2 15h2v2H2Zm14 0h2v2h-2Z" fill="currentColor" stroke="none"/>'),
  copy: svg('<rect x="6.5" y="6.5" width="10.5" height="10.5" rx="1.2"/><path d="M4 13V4h9"/>'),
  folder: svg('<path d="M3 15V5h5l2 2h7v8Z"/>'),
  chevron: svg('<path d="m8 5 5 5-5 5"/>'),
  moveUp: svg('<path d="M10 16V4m-5 5 5-5 5 5"/>'),
  moveDown: svg('<path d="M10 4v12m-5-5 5 5 5-5"/>'),
  trash: svg('<path d="M3.5 5.5h13m-11 0 .8 11h7.4l.8-11M7.5 5.5V3h5v2.5m-4 3v5m3-5v5"/>'),
  object: svg('<path d="m10 2 7 4v8l-7 4-7-4V6l7-4Z M3 6l7 4 7-4 M10 10v8"/>'),
  material: svg('<circle cx="10" cy="10" r="7"/><path d="M10 3a7 7 0 0 1 0 14Z" fill="currentColor" stroke="none"/>'),
  rendered: svg('<circle cx="10" cy="10" r="7"/><circle cx="10" cy="10" r="3" fill="currentColor" stroke="none"/>'),
  renderCamera: svg('<rect x="2.5" y="5" width="15" height="11" rx="1.4"/><path d="M6 5 7.5 3.5h5L14 5"/><circle cx="10" cy="10.5" r="2.7"/>'),
  renderCameraOff: svg('<path d="m3 3 14 14M3 7v8a1 1 0 0 0 1 1h8M7 5l.5-1.5h5L14 5h2.5a1 1 0 0 1 1 1v6M10 8a2.5 2.5 0 0 1 2.5 2.5"/>'),
  eye: svg('<path d="M2 10s3-5 8-5 8 5 8 5-3 5-8 5-8-5-8-5Z"/><circle cx="10" cy="10" r="2"/>'),
  hidden: svg('<path d="m3 3 14 14 M7 5.5A9 9 0 0 1 10 5c5 0 8 5 8 5a14 14 0 0 1-2.5 3 M12.5 14.6A9 9 0 0 1 10 15c-5 0-8-5-8-5a14 14 0 0 1 2.5-3"/>'),
  lock: svg('<rect x="4.5" y="8.5" width="11" height="8" rx="1.5"/><path d="M7 8.5V6a3 3 0 0 1 6 0v2.5M10 12v1.4"/>'),
  unlock: svg('<rect x="4.5" y="8.5" width="11" height="8" rx="1.5"/><path d="M7 8.5V6a3 3 0 0 1 5.8-1M10 12v1.4"/>'),
  focus: svg('<path d="M7 3H3v4 M13 3h4v4 M3 13v4h4 M17 13v4h-4"/><circle cx="10" cy="10" r="2.5"/>'),
  search: svg('<circle cx="8.8" cy="8.8" r="4.8"/><path d="m12.3 12.3 4.1 4.1"/>'),
  filter: svg('<path d="M3 4h14l-5.5 6.5v5L8.5 17v-6.5Z"/>'),
  fit: svg('<path d="M7 3H3v4 M13 3h4v4 M3 13v4h4 M17 13v4h-4 M7 7h6v6H7Z"/>'),
  grid: svg('<rect x="3" y="3" width="14" height="14" rx="1"/><path d="M3 8h14 M3 13h14 M8 3v14 M13 3v14"/>'),
  orthographic: svg('<rect x="4" y="4" width="12" height="12" rx="1"/><path d="M1 7v6 M19 7v6 M7 1h6 M7 19h6"/>'),
  pin: svg('<path d="m7 3 6 0-1 4 3 3v2H5v-2l3-3-1-4Z M10 12v6"/>'),
  close: svg('<path d="m6 6 8 8 M14 6l-8 8"/>'),
  return: svg('<path d="m7 5-4 4 4 4 M3 9h9a4 4 0 0 1 0 8"/>'),
  image: svg('<rect x="2.5" y="3" width="15" height="14" rx="2"/><circle cx="7" cy="7.5" r="1.3"/><path d="m3 14 4-4 3 3 3-5 4 6"/>'),
  history: svg('<path d="M3 8a7 7 0 1 1 0 5 M3 3v5h5 M10 6v4l3 2"/>'),
  pen: svg('<path d="m12 4 4 4 M4 12l9-9 4 4-9 9-5 1 1-5Z"/>'),
  text: svg('<path d="M3 5h14 M10 5v11 M7 16h6 M3 5v2 M17 5v2"/>'),
  marquee: svg('<rect x="3" y="3" width="14" height="14" stroke-dasharray="2 2"/>'),
  lasso: svg('<path d="M5.5 13.5C2 12.3 2 8.3 4.4 6.3c2.9-2.5 9.5-2.7 12.2.2 2.1 2.3.4 5.5-3.4 6.7-2.8.9-6.8.3-7.5 1.9-.9 1.8 1.8 2.4 2.6 1 .5-.9-.2-2.2-1.4-2.7"/>'),
  transform: svg('<path d="M3 7V3h4m6 0h4v4m0 6v4h-4m-6 0H3v-4m7-6v6M7 10h6"/>'),
  hand: svg('<path d="M6 10V6a1 1 0 0 1 2 0v3-5a1 1 0 0 1 2 0v5-6a1 1 0 0 1 2 0v6-4a1 1 0 0 1 2 0v6l1.5-1.5a1.3 1.3 0 0 1 2 1.6l-3 4.4A4 4 0 0 1 11 17H9a4 4 0 0 1-3.3-1.8L3 11a1.3 1.3 0 0 1 2-1.6L6 10Z"/>'),
  brush: svg('<path d="m7.5 11.5 6.7-7.8a1.5 1.5 0 0 1 2.1 2.1l-7.8 6.7M7 12a2.5 2.5 0 0 0-2.5 2.5c0 1-.5 2-1.5 2.5h3a3 3 0 0 0 3-3 2 2 0 0 0-2-2Z"/>'),
  eyedropper: svg('<path d="m11 6 3 3m-4-2 2-2 3 3-2 2m-.7-4.7 2-2a1.4 1.4 0 0 1 2 2l-2 2M11 8l-6 6-.5 1.5-.5.5 1 .5.5-.5L7 16l6-6"/>'),
  eraser: svg('<path d="m8 4 8 6a1.2 1.2 0 0 1 .2 1.7L12 17H7l-4-3a1.2 1.2 0 0 1-.2-1.7l5.2-8.3Zm-3 5 8 6m-6 2h10"/>'),
  mask: svg('<rect x="3" y="4" width="14" height="12" rx="1"/><circle cx="10" cy="10" r="3.2" fill="currentColor" stroke="none"/>'),
  fillLayer: svg('<path d="m3 8 7-4 7 4-7 4-7-4Zm0 4 7 4 7-4"/><path d="m5 9.2 7-4m-4 5.8 7-4"/>'),
  settings: svg('<path d="m8 3 .5-1h3l.5 2 2 .8 2-.5 1.5 2.6-1.5 1.4V11l1.5 1.4-1.5 2.6-2-.5-2 .8-.5 2h-3l-.5-2-2-.8-2 .5-1.5-2.6L4 11V8.3L2.5 7 4 4.3l2 .5 2-.8Z"/><circle cx="10" cy="9.7" r="2.5"/>'),
  plus: svg('<path d="M10 4v12 M4 10h12"/>'),
  info: svg('<circle cx="10" cy="10" r="7"/><path d="M10 9v5 M10 6h.01"/>'),
  refresh: svg('<path d="M16.5 8A6.5 6.5 0 0 0 5 5L2.5 8 M2.5 3v5h5 M3.5 12A6.5 6.5 0 0 0 15 15l2.5-3 M17.5 17v-5h-5"/>')
};

export function decorateWorkspaceButtons(root, selectors) {
  for (const [selector, icon] of Object.entries(selectors)) {
    for (const button of root.querySelectorAll(selector)) {
      if (button.querySelector('.chrome-icon')) continue;
      const label = button.textContent.trim();
      if (!button.hasAttribute('aria-label')) button.setAttribute('aria-label', label);
      button.title ||= button.getAttribute('aria-label');
      const text = document.createElement('span');
      text.className = 'tool-label';
      text.textContent = label;
      button.innerHTML = workspaceIcons[icon];
      button.append(text);
    }
  }
}
