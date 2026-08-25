'use strict';

/**
 * Demo console for cookie-based per-layer version routing.
 *
 * The cookies are set client-side and scoped to this browser, which is the point: one developer
 * pinning a version changes nothing for anyone else. bag_orch and bag_service take effect on the
 * next API call; bag_fed is matched by the ingress gateway before the page is served, so changing
 * it requires a full reload.
 */

const COOKIES = [
  { name: 'bag_fed', pins: 'bag-ui', example: 'feature1', needsReload: true },
  { name: 'bag_orch', pins: 'bag-xapi', example: '2.3', needsReload: false },
  { name: 'bag_service', pins: 'bag-service', example: '1.10', needsReload: false },
];

function readCookies() {
  const jar = {};
  for (const part of document.cookie.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    jar[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return jar;
}

function setCookie(name, value) {
  document.cookie = `${name}=${encodeURIComponent(value)}; path=/; max-age=86400; SameSite=Lax`;
}

function clearCookie(name) {
  document.cookie = `${name}=; path=/; max-age=0; SameSite=Lax`;
}

/** Derive the accent colour from the serving UI version, so a bag_fed switch is visible instantly. */
function applyVersionAccent(version) {
  if (!version) return;
  let hash = 0;
  for (const ch of version) hash = (hash * 31 + ch.charCodeAt(0)) % 360;
  document.documentElement.style.setProperty('--accent', `hsl(${hash}, 62%, 48%)`);
}

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  for (const child of [].concat(children)) {
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function versionChip(requested, serving) {
  if (serving === null || serving === undefined) {
    return el('span', { className: 'chip missing' }, 'unreachable');
  }
  const pinned = requested !== null && requested !== undefined && requested !== '';

  if (!pinned) {
    const chip = el('span', { className: 'chip default-version' }, serving);
    chip.title = 'No cookie set for this layer — served by the catch-all (default) route';
    return chip;
  }

  // A cookie was set but a different version answered. Either no VirtualService rule matches this
  // value, or the routing context was dropped before this hop. Expected with docker compose,
  // where there is no mesh to act on the cookie at all.
  if (String(requested) !== String(serving)) {
    const chip = el('span', { className: 'chip unrouted' }, `${serving} \u2260 ${requested}`);
    chip.title = `Cookie asked for ${requested} but ${serving} answered — no matching route, `
      + 'or the routing context was not propagated this far.';
    return chip;
  }

  const chip = el('span', { className: 'chip pinned' }, serving);
  chip.title = `Pinned by cookie to ${requested}`;
  return chip;
}

function money(value, currency) {
  if (typeof value !== 'number') return '—';
  return `${currency === 'USD' ? '$' : ''}${value.toFixed(2)}`;
}

function renderCookieControls() {
  const jar = readCookies();
  const grid = document.getElementById('cookie-grid');
  grid.replaceChildren();

  for (const cookie of COOKIES) {
    const current = jar[cookie.name] ?? '';
    const input = el('input', {
      type: 'text',
      value: current,
      placeholder: `unset — e.g. ${cookie.example}`,
      id: `input-${cookie.name}`,
    });

    const apply = el('button', { className: 'btn' }, 'Apply');
    apply.addEventListener('click', () => {
      const value = input.value.trim();
      if (value === '') {
        clearCookie(cookie.name);
      } else {
        setCookie(cookie.name, value);
      }
      afterCookieChange(cookie);
    });

    const clear = el('button', { className: 'btn btn-ghost' }, 'Clear');
    clear.addEventListener('click', () => {
      clearCookie(cookie.name);
      input.value = '';
      afterCookieChange(cookie);
    });

    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') apply.click();
    });

    grid.append(
      el('div', { className: 'cookie-row' }, [
        el('div', { className: 'label' }, [
          el('code', {}, cookie.name),
          el('span', { className: 'pins' }, `pins ${cookie.pins}`),
        ]),
        input,
        apply,
        clear,
      ]),
    );
  }
}

function afterCookieChange(cookie) {
  if (cookie.needsReload) {
    const note = document.getElementById('reload-note');
    note.hidden = false;
    setTimeout(() => window.location.reload(), 400);
    return;
  }
  load();
}

function renderChain(chain) {
  const body = document.querySelector('#chain-table tbody');
  body.replaceChildren();
  for (const hop of chain ?? []) {
    body.append(
      el('tr', {}, [
        el('td', {}, [el('code', {}, hop.layer)]),
        el('td', {}, [el('code', {}, hop.cookie)]),
        el('td', {}, [
          hop.requestedVersion
            ? el('span', { className: 'chip' }, hop.requestedVersion)
            : el('span', { className: 'chip unset' }, 'unset'),
        ]),
        el('td', {}, [versionChip(hop.requestedVersion, hop.servingVersion)]),
        el('td', {}, [el('code', {}, hop.instance ?? '—')]),
      ]),
    );
  }
}

function renderPropagation(propagation) {
  const body = document.querySelector('#propagation-table tbody');
  body.replaceChildren();
  for (const entry of propagation ?? []) {
    const received = entry.received ?? {};
    body.append(
      el('tr', {}, [
        el('td', {}, [el('code', {}, entry.layer)]),
        ...['bag_fed', 'bag_orch', 'bag_service'].map((name) => {
          const value = received[name];
          return el('td', {}, [
            value
              ? el('span', { className: 'chip pinned' }, value)
              : el('span', { className: 'chip unset' }, 'not set'),
          ]);
        }),
      ]),
    );
  }
}

function renderItems(data) {
  const body = document.querySelector('#items-table tbody');
  body.replaceChildren();
  const currency = data.currency ?? 'USD';

  for (const item of data.items ?? []) {
    const line = Math.round(item.unitPrice * item.quantity * 100) / 100;
    body.append(
      el('tr', {}, [
        el('td', {}, item.name),
        el('td', {}, [el('code', {}, item.sku)]),
        el('td', {}, item.colour ?? '—'),
        el('td', {}, item.size ?? '—'),
        el('td', { className: 'num' }, item.quantity),
        el('td', { className: 'num' }, money(item.unitPrice, currency)),
        el('td', { className: 'num' }, money(line, currency)),
      ]),
    );
  }

  if (!(data.items ?? []).length) {
    body.append(el('tr', {}, [el('td', { colSpan: 7 }, 'No items returned.')]));
  }

  const totals = document.getElementById('totals');
  totals.replaceChildren();
  totals.append(
    el('div', { className: 'row' }, [el('span', {}, 'Subtotal'), el('span', {}, money(data.subtotal, currency))]),
  );
  if (data.promotion) {
    totals.append(
      el('div', { className: 'row promo' }, [
        el('span', {}, `${data.promotion.code} — ${data.promotion.description}`),
        el('span', {}, `-${money(data.promotion.discount, currency)}`),
      ]),
    );
  }
  totals.append(
    el('div', { className: 'row grand' }, [el('span', {}, 'Total'), el('span', {}, money(data.total, currency))]),
  );
  if (data.estimatedDelivery) {
    totals.append(
      el('div', { className: 'row' }, [el('span', {}, 'Estimated delivery'), el('span', {}, data.estimatedDelivery)]),
    );
  }
}

async function load() {
  renderCookieControls();

  const errorBox = document.getElementById('bag-error');
  errorBox.hidden = true;

  let data;
  try {
    const response = await fetch('/api/bags', { credentials: 'same-origin', cache: 'no-store' });
    data = await response.json();
  } catch (err) {
    errorBox.hidden = false;
    errorBox.textContent = `Could not reach bag-ui: ${err.message}`;
    return;
  }

  const uiVersion = data.ui?.version ?? null;
  document.getElementById('ui-version-chip').textContent = uiVersion ?? '?';
  document.getElementById('ui-instance').textContent = data.ui?.instance ?? '';
  applyVersionAccent(uiVersion);

  renderChain(data.chain);
  renderPropagation(data.propagation);
  renderItems(data);

  if (data.downstream?.status === 'ERROR') {
    errorBox.hidden = false;
    errorBox.textContent =
      `Downstream call to ${data.downstream.url} failed: ${data.downstream.error ?? 'HTTP ' + data.downstream.httpStatus}`;
  }

  document.getElementById('raw').textContent = JSON.stringify(data, null, 2);
}

document.getElementById('refresh').addEventListener('click', load);
document.getElementById('clear-all').addEventListener('click', () => {
  for (const cookie of COOKIES) clearCookie(cookie.name);
  window.location.reload();
});

load();
