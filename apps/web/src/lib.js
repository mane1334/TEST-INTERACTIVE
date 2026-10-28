// Funções puras do cliente (testáveis sem navegador).

export const STATUS = {
  pending: { label: 'Recebido', step: 1, hint: 'A cozinha vai começar já' },
  preparing: { label: 'Em preparo', step: 2, hint: 'Estamos a preparar o teu pedido' },
  completed: { label: 'Pronto', step: 3, hint: 'Já vai a caminho da tua mesa' },
  cancelled: { label: 'Cancelado', step: 0, hint: 'Este pedido foi cancelado' },
};

export function formatPrice(value, currency = 'MT') {
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  const rounded = Math.round(n * 100) / 100;
  const text = Number.isInteger(rounded)
    ? String(rounded)
    : rounded.toFixed(2).replace('.', ',');
  return `${text.replace(/\B(?=(\d{3})+(?!\d|,))/g, ' ')} ${currency}`;
}

// Lê a lista de imagens de um prato (image_urls pode ser JSON em texto ou lista).
export function dishImages(dish) {
  let list = [];
  const raw = dish && dish.image_urls;
  if (Array.isArray(raw)) list = raw;
  else if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) list = parsed;
    } catch (_) { /* texto inválido: ignora */ }
  }
  if (dish && dish.image_url) list = [dish.image_url, ...list];
  return Array.from(new Set(list.filter((u) => typeof u === 'string' && u)));
}

export function groupCategories(dishes) {
  const seen = new Map();
  for (const d of dishes) {
    const name = d.category_name || 'Outros';
    if (!seen.has(name)) seen.set(name, 0);
    seen.set(name, seen.get(name) + 1);
  }
  return Array.from(seen, ([name, count]) => ({ name, count }));
}

export function trayTotal(tray, dishesById) {
  return Object.entries(tray).reduce((sum, [id, qty]) => {
    const dish = dishesById.get(Number(id));
    return dish ? sum + Number(dish.price) * qty : sum;
  }, 0);
}

export function trayCount(tray) {
  return Object.values(tray).reduce((a, b) => a + b, 0);
}

export function trayToItems(tray) {
  return Object.entries(tray)
    .filter(([, qty]) => qty > 0)
    .map(([id, quantity]) => ({ dish_id: Number(id), quantity }));
}

export function secondsLeft(untilIso, now = Date.now()) {
  if (!untilIso) return 0;
  const t = Date.parse(String(untilIso).includes('T') || String(untilIso).endsWith('Z') ? untilIso : String(untilIso).replace(' ', 'T') + 'Z');
  return Number.isFinite(t) ? Math.max(0, Math.round((t - now) / 1000)) : 0;
}

export function progressPercent(status) {
  const s = STATUS[status];
  return s && s.step ? Math.round((s.step / 3) * 100) : 0;
}
