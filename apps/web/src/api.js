// Cliente da API. O restaurante vem do endereço (?r=ID) ou de VITE_RESTAURANT_ID; a mesa de ?mesa=N.

const params = new URLSearchParams(window.location.search);

export const restaurantId = params.get('r') || import.meta.env.VITE_RESTAURANT_ID || '';
export const tableNumber = params.get('mesa') || '';

async function request(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'x-restaurant-id': restaurantId,
      ...(options.headers || {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error || `Erro ${res.status}`);
    err.status = res.status;
    err.code = body.code;
    throw err;
  }
  return body;
}

export const api = {
  menu: () => request('/menu'),
  settings: () => request('/settings'),
  createOrder: (table_number, items, notes) => request('/orders', { method: 'POST', body: JSON.stringify({ table_number, items, notes: notes || undefined }) }),
  // O código do pedido (devolvido ao criar) prova que o pedido é nosso.
  getOrder: (id, code) => request(`/orders/${id}`, { headers: { 'x-order-code': code || '' } }),
  cancelOrder: (id, code) => request(`/orders/${id}/cancel`, { method: 'POST', body: '{}', headers: { 'x-order-code': code || '' } }),
  callWaiter: (table_number, reason) => request('/call-waiter', { method: 'POST', body: JSON.stringify({ table_number, reason }) }),
  rate: (payload) => request('/ratings', { method: 'POST', body: JSON.stringify(payload) }),
};

// Tempo real: reconecta sozinho. Devolve uma função para fechar.
export function openEvents(onEvent, onState) {
  let ws;
  let closed = false;
  let retry = 0;
  const connect = () => {
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${window.location.host}/ws?restaurant_id=${encodeURIComponent(restaurantId)}`);
    ws.onopen = () => { retry = 0; onState?.(true); };
    ws.onmessage = (m) => { try { onEvent(JSON.parse(m.data)); } catch (_) { /* ignora */ } };
    ws.onclose = () => {
      onState?.(false);
      if (!closed) setTimeout(connect, Math.min(15000, 1000 * 2 ** retry++));
    };
  };
  connect();
  return () => { closed = true; ws && ws.close(); };
}

// Guardar localmente sem rebentar em modo privado
export const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(`kt:${restaurantId}:${key}`); return v ? JSON.parse(v) : fallback; } catch (_) { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(`kt:${restaurantId}:${key}`, JSON.stringify(value)); } catch (_) { /* sem armazenamento */ }
  },
};
